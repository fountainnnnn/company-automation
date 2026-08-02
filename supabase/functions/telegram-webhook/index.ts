// Telegram bot webhook — construction-site reporting + attendance.
//
// Stateless: every update re-resolves the worker and the chat session from the
// database. Secrets and settings are cached in module scope for the lifetime of
// the isolate. Always answers 200 for authenticated updates so Telegram never
// enters a retry storm because of an internal failure.

import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// ---------------------------------------------------------------- types

interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TgVideo {
  file_id: string;
  width?: number;
  height?: number;
  mime_type?: string;
  file_size?: number;
  file_name?: string;
}

interface TgDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TgLocation {
  latitude: number;
  longitude: number;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type?: string };
  text?: string;
  caption?: string;
  location?: TgLocation;
  photo?: TgPhotoSize[];
  video?: TgVideo;
  document?: TgDocument;
  media_group_id?: string;
}

interface TgCallbackQuery {
  id: string;
  from: TgUser;
  data?: string;
  message?: TgMessage;
}

interface TgUpdate {
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

interface Worker {
  id: number;
  full_name: string;
  telegram_user_id: number | null;
  telegram_username: string | null;
  status: "pending" | "active" | "disabled";
  default_project_id: number | null;
}

interface Project {
  id: number;
  code: string;
  name: string;
}

interface Report {
  id: number;
  project_id: number;
  worker_id: number;
  report_date: string;
  note: string | null;
}

interface Attendance {
  id: number;
  worker_id: number;
  project_id: number | null;
  check_in_at: string;
  in_lat: number;
  in_lng: number;
  flags: string[];
}

/** Media descriptor; pending items are persisted in the pending_media table. */
interface MediaDescriptor {
  media_type: "photo" | "video" | "document";
  telegram_file_id: string;
  mime_type: string | null;
  file_size: number | null;
  width: number | null;
  height: number | null;
  media_group_id: string | null;
  file_name: string | null;
  ext: string;
}

interface Draft {
  project_id?: number;
  report_id?: number;
  pending_group?: string | null;
}

type SessionState =
  | "idle"
  | "registering"
  | "awaiting_checkin_location"
  | "awaiting_checkout_location"
  | "choosing_project_for_media"
  | "adding_note"
  | "typing_date";

interface Session {
  chat_id: number;
  worker_id: number | null;
  state: SessionState;
  draft: Draft;
}

interface InlineButton {
  text: string;
  callback_data: string;
}

// ---------------------------------------------------------------- config

interface Config {
  botToken: string;
  webhookSecret: string;
}

interface Settings {
  timezone: string;
  flagDistanceKm: number;
}

let configPromise: Promise<Config> | null = null;

function getConfig(): Promise<Config> {
  if (!configPromise) {
    configPromise = loadConfig().catch((err) => {
      // Allow a later request to retry a transient load failure.
      configPromise = null;
      throw err;
    });
  }
  return configPromise;
}

async function loadConfig(): Promise<Config> {
  const secrets = await supabase
    .from("app_secrets")
    .select("key, value")
    .in("key", ["telegram_bot_token", "telegram_webhook_secret"]);
  if (secrets.error) throw secrets.error;

  const secretMap = new Map<string, string>(
    (secrets.data ?? []).map((r) => [r.key as string, r.value as string]),
  );
  const botToken = secretMap.get("telegram_bot_token");
  const webhookSecret = secretMap.get("telegram_webhook_secret");
  if (!botToken || !webhookSecret) {
    throw new Error("app_secrets is missing telegram_bot_token / telegram_webhook_secret");
  }
  return { botToken, webhookSecret };
}

// Settings are admin-tunable, so a warm isolate must pick changes up: 60s TTL.
const SETTINGS_TTL_MS = 60_000;
let settingsCache: { value: Settings; at: number } | null = null;

async function getSettings(): Promise<Settings> {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) {
    return settingsCache.value;
  }
  const res = await supabase.from("settings").select("key, value").in("key", [
    "timezone",
    "flag_distance_km",
  ]);
  if (res.error) {
    // fall back to the stale value rather than failing the update
    if (settingsCache) return settingsCache.value;
    throw res.error;
  }
  const map = new Map<string, unknown>(
    (res.data ?? []).map((r) => [r.key as string, r.value]),
  );
  const tz = map.get("timezone");
  const km = map.get("flag_distance_km");
  const value: Settings = {
    timezone: typeof tz === "string" && tz ? tz : "Asia/Singapore",
    flagDistanceKm: typeof km === "number" && km > 0 ? km : 10,
  };
  settingsCache = { value, at: Date.now() };
  return value;
}

// ---------------------------------------------------------------- telegram

// deno-lint-ignore no-explicit-any
type TgResult = any;

async function tg(method: string, payload: Record<string, unknown>): Promise<TgResult> {
  const { botToken } = await getConfig();
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!res.ok || !body?.ok) {
      console.error(`telegram ${method} failed`, res.status, JSON.stringify(body));
      return null;
    }
    return body.result;
  } catch (err) {
    console.error(`telegram ${method} threw`, err);
    return null;
  }
}

function send(chatId: number, text: string, extra: Record<string, unknown> = {}) {
  return tg("sendMessage", { chat_id: chatId, text, ...extra });
}

function answerCallback(id: string, text?: string) {
  return tg("answerCallbackQuery", text ? { callback_query_id: id, text } : { callback_query_id: id });
}

function editKeyboard(chatId: number, messageId: number, rows: InlineButton[][]) {
  return tg("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: rows },
  });
}

const LOCATION_KEYBOARD = {
  keyboard: [[{ text: "📍 Share location", request_location: true }]],
  one_time_keyboard: true,
  resize_keyboard: true,
};

const REMOVE_KEYBOARD = { remove_keyboard: true };

// ---------------------------------------------------------------- time helpers

async function tz(): Promise<string> {
  return (await getSettings()).timezone;
}

async function fmtTime(when: Date | string): Promise<string> {
  const d = typeof when === "string" ? new Date(when) : when;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: await tz(),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/** "3 Aug" */
async function fmtDate(isoDate: string): Promise<string> {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: await tz(),
    day: "numeric",
    month: "short",
  }).format(d);
}

/** Today (or today minus `daysBack`) as YYYY-MM-DD in the configured timezone. */
async function localDate(daysBack = 0): Promise<string> {
  const d = new Date(Date.now() - daysBack * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: await tz(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function fmtDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(a))));
}

// ---------------------------------------------------------------- session

/** A non-idle state left alone this long is stale — revert to idle, keep the sticky project. */
const SESSION_STALE_MS = 30 * 60_000;

async function getSession(chatId: number): Promise<Session> {
  const { data, error } = await supabase
    .from("chat_sessions")
    .select("chat_id, worker_id, state, draft, updated_at")
    .eq("chat_id", chatId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return { chat_id: chatId, worker_id: null, state: "idle", draft: {} };

  let state = (data.state ?? "idle") as SessionState;
  let draft = (data.draft ?? {}) as Draft;
  const age = Date.now() - new Date(data.updated_at).getTime();
  if (state !== "idle" && age > SESSION_STALE_MS) {
    state = "idle";
    draft = resetDraft(draft);
  }

  return {
    chat_id: chatId,
    worker_id: data.worker_id ?? null,
    state,
    draft,
  };
}

async function saveSession(session: Session, patch: Partial<Session>): Promise<Session> {
  const next: Session = {
    chat_id: session.chat_id,
    worker_id: patch.worker_id !== undefined ? patch.worker_id : session.worker_id,
    state: patch.state ?? session.state,
    draft: patch.draft ?? session.draft,
  };
  const { error } = await supabase.from("chat_sessions").upsert(
    {
      chat_id: next.chat_id,
      worker_id: next.worker_id,
      state: next.state,
      draft: next.draft,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "chat_id" },
  );
  if (error) throw error;
  // keep the caller's object in sync so later steps in the same update see it
  session.worker_id = next.worker_id;
  session.state = next.state;
  session.draft = next.draft;
  return session;
}

/** Clear transient draft keys, keeping the sticky project. */
function resetDraft(draft: Draft): Draft {
  return draft.project_id ? { project_id: draft.project_id } : {};
}

// ---------------------------------------------------------------- data access

async function findWorker(telegramUserId: number): Promise<Worker | null> {
  const { data, error } = await supabase
    .from("workers")
    .select("id, full_name, telegram_user_id, telegram_username, status, default_project_id")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();
  if (error) throw error;
  return (data as Worker) ?? null;
}

async function getProject(projectId: number): Promise<Project | null> {
  const { data, error } = await supabase
    .from("projects")
    .select("id, code, name")
    .eq("id", projectId)
    .maybeSingle();
  if (error) throw error;
  return (data as Project) ?? null;
}

/** Projects assigned to the worker; falls back to every active project. */
async function listProjects(workerId: number): Promise<Project[]> {
  const assigned = await supabase
    .from("project_workers")
    .select("projects!inner(id, code, name, status)")
    .eq("worker_id", workerId)
    .eq("projects.status", "active");
  if (assigned.error) throw assigned.error;

  const mine = (assigned.data ?? [])
    .map((row) => (row as { projects: Project | null }).projects)
    .filter((p): p is Project => Boolean(p))
    .map((p) => ({ id: p.id, code: p.code, name: p.name }));

  if (mine.length > 0) {
    return mine.sort((a, b) => a.code.localeCompare(b.code));
  }

  const all = await supabase
    .from("projects")
    .select("id, code, name")
    .eq("status", "active")
    .order("code");
  if (all.error) throw all.error;
  return (all.data ?? []) as Project[];
}

async function openAttendance(workerId: number): Promise<Attendance | null> {
  // "open" = not checked out and not administratively closed by the no_checkout
  // sweep — review flags (far_apart etc.) never hide a live shift from the bot.
  const { data, error } = await supabase
    .from("attendance")
    .select("id, worker_id, project_id, check_in_at, in_lat, in_lng, flags")
    .eq("worker_id", workerId)
    .is("check_out_at", null)
    .not("flags", "cs", "{no_checkout}")
    .maybeSingle();
  if (error) throw error;
  return (data as Attendance) ?? null;
}

async function projectKeyboard(
  workerId: number,
  prefix: string,
  suffixId?: number,
): Promise<InlineButton[][] | null> {
  const projects = await listProjects(workerId);
  if (projects.length === 0) return null;
  return projects.map((p) => [
    {
      text: `${p.code} — ${p.name}`,
      callback_data: suffixId !== undefined
        ? `${prefix}:${suffixId}:${p.id}`
        : `${prefix}:${p.id}`,
    },
  ]);
}

// ---------------------------------------------------------------- messages

const HELP_TEXT = [
  "Here's what I can do:",
  "",
  "• Send photos, videos or files — I save them as a site report.",
  "• Add a caption and it becomes the report note.",
  "• /checkin and /checkout — share your location to log your hours.",
  "• /project — switch the site you're reporting for.",
  "• /status — see your current site and check-in.",
].join("\n");

function reportButtons(reportId: number): InlineButton[][] {
  return [
    [{ text: "✏️ Add note", callback_data: `rn:${reportId}` }],
    [{ text: "📅 Set date", callback_data: `rd:${reportId}` }],
    [{ text: "📁 Change project", callback_data: `rp:${reportId}` }],
  ];
}

async function sendReportConfirmation(chatId: number, report: Report, code: string) {
  await send(chatId, `✅ Saved → ${code} · ${await fmtDate(report.report_date)}`, {
    reply_markup: { inline_keyboard: reportButtons(report.id) },
  });
}

// ---------------------------------------------------------------- entrypoint

Deno.serve(async (req) => {
  let cfg: Config;
  try {
    cfg = await getConfig();
  } catch (err) {
    console.error("config load failed", err);
    return jsonResponse({ ok: false, error: "config_unavailable" }, 500);
  }

  if (req.headers.get("x-telegram-bot-api-secret-token") !== cfg.webhookSecret) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  let update: TgUpdate;
  try {
    update = await req.json();
  } catch (err) {
    console.error("bad json body", err);
    return jsonResponse({ ok: true });
  }

  try {
    await handleUpdate(update);
  } catch (err) {
    console.error("update handling failed", err);
    // secret header already validated above — safe to echo diagnostics to the tester
    if (req.headers.get("x-debug") === "1") {
      const e = err as { message?: string; code?: string };
      return jsonResponse({ ok: false, error: String(e?.message ?? err), code: e?.code ?? null });
    }
  }

  return jsonResponse({ ok: true });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function handleUpdate(update: TgUpdate): Promise<void> {
  if (update.callback_query) return handleCallbackQuery(update.callback_query);
  if (update.message) return handleMessage(update.message);
  return Promise.resolve();
}

// ---------------------------------------------------------------- messages in

async function handleMessage(message: TgMessage): Promise<void> {
  const from = message.from;
  if (!from || !message.chat?.id) return;
  // Private chats only: in a group, sessions (keyed by chat) and identities
  // (keyed by sender) would cross-attribute reports and check-ins.
  if (message.chat.type && message.chat.type !== "private") return;

  const chatId = message.chat.id;
  const session = await getSession(chatId);
  const worker = await findWorker(from.id);

  if (!worker) return handleUnregistered(chatId, session, message, from);

  if (session.worker_id !== worker.id) {
    await saveSession(session, { worker_id: worker.id });
  }

  if (worker.status === "pending") {
    await send(chatId, "Your registration is awaiting admin approval.");
    return;
  }
  if (worker.status === "disabled") {
    await send(chatId, "Your account is disabled. Contact your admin.");
    return;
  }

  const command = parseCommand(message.text);
  if (command) return handleCommand(command, chatId, worker, session);

  if (message.location) return handleLocation(chatId, worker, session, message.location);

  const media = extractMedia(message);
  if (media) return handleIncomingMedia(chatId, worker, session, media, message.caption ?? null);

  const text = (message.text ?? "").trim();
  if (!text) return;

  switch (session.state) {
    case "awaiting_checkin_location":
    case "awaiting_checkout_location":
      await send(chatId, "Location is required — please tap the 📍 button.", {
        reply_markup: LOCATION_KEYBOARD,
      });
      return;
    case "adding_note":
      return saveNoteFromText(chatId, worker, session, text);
    case "typing_date":
      return saveDateFromText(chatId, worker, session, text);
    case "choosing_project_for_media":
      await send(chatId, "Pick a project from the buttons above first.");
      return;
    default:
      await send(chatId, HELP_TEXT);
  }
}

async function handleUnregistered(
  chatId: number,
  session: Session,
  message: TgMessage,
  from: TgUser,
): Promise<void> {
  const text = (message.text ?? "").trim();

  if (session.state === "registering" && text && !text.startsWith("/")) {
    const { error } = await supabase.from("workers").insert({
      full_name: text.slice(0, 120),
      telegram_user_id: from.id,
      telegram_username: from.username ?? null,
      status: "pending",
    });
    if (error) throw error;
    await saveSession(session, { state: "idle", draft: {} });
    await send(
      chatId,
      `Thanks, ${text.slice(0, 120)}. Your account has been created — an admin needs to approve it before you can send reports.`,
    );
    return;
  }

  await saveSession(session, { state: "registering", draft: {} });
  await send(chatId, "Welcome to CL Automation. Please send your full name to register.");
}

// ---------------------------------------------------------------- commands

function parseCommand(text?: string): string | null {
  if (!text || !text.startsWith("/")) return null;
  const raw = text.trim().split(/\s+/)[0].slice(1);
  return raw.split("@")[0].toLowerCase();
}

async function handleCommand(
  command: string,
  chatId: number,
  worker: Worker,
  session: Session,
): Promise<void> {
  switch (command) {
    case "start":
    case "help":
      await send(chatId, HELP_TEXT, { reply_markup: REMOVE_KEYBOARD });
      return;
    case "cancel": {
      const { data: pend } = await supabase
        .from("pending_media")
        .select("id")
        .eq("chat_id", chatId);
      if (pend?.length) {
        await supabase.from("pending_media").delete().eq("chat_id", chatId);
      }
      await saveSession(session, { state: "idle", draft: resetDraft(session.draft) });
      await send(
        chatId,
        pend?.length
          ? `Cancelled — discarded ${pend.length} unsaved file(s).`
          : "Cancelled.",
        { reply_markup: REMOVE_KEYBOARD },
      );
      return;
    }
    case "project":
      return cmdProject(chatId, worker);
    case "status":
      return cmdStatus(chatId, worker, session);
    case "checkin":
      return cmdCheckin(chatId, worker, session);
    case "checkout":
      return cmdCheckout(chatId, worker, session);
    default:
      await send(chatId, "I don't know that command. Send /help to see what I can do.");
  }
}

async function cmdProject(chatId: number, worker: Worker): Promise<void> {
  const rows = await projectKeyboard(worker.id, "pj");
  if (!rows) {
    await send(chatId, "No active projects yet. Ask your admin to set one up.");
    return;
  }
  await send(chatId, "Which site are you on?", { reply_markup: { inline_keyboard: rows } });
}

async function cmdStatus(chatId: number, worker: Worker, session: Session): Promise<void> {
  const projectId = session.draft.project_id ?? worker.default_project_id;
  const project = projectId ? await getProject(projectId) : null;
  const open = await openAttendance(worker.id);

  const lines = [
    project ? `Project: ${project.code} — ${project.name}` : "Project: not set — use /project",
    open
      ? `Checked in since ${await fmtTime(open.check_in_at)}`
      : "Not checked in",
  ];
  await send(chatId, lines.join("\n"));
}

async function cmdCheckin(chatId: number, worker: Worker, session: Session): Promise<void> {
  const open = await openAttendance(worker.id);
  if (open) {
    await send(
      chatId,
      `Already checked in since ${await fmtTime(open.check_in_at)}. Use /checkout first.`,
    );
    return;
  }
  await saveSession(session, { state: "awaiting_checkin_location" });
  await send(chatId, "Tap to share your location — required to check in.", {
    reply_markup: LOCATION_KEYBOARD,
  });
}

async function cmdCheckout(chatId: number, worker: Worker, session: Session): Promise<void> {
  const open = await openAttendance(worker.id);
  if (!open) {
    await send(chatId, "You're not checked in. Use /checkin.");
    return;
  }
  await saveSession(session, { state: "awaiting_checkout_location" });
  await send(chatId, "Tap to share your location — required to check out.", {
    reply_markup: LOCATION_KEYBOARD,
  });
}

// ---------------------------------------------------------------- attendance

async function handleLocation(
  chatId: number,
  worker: Worker,
  session: Session,
  location: TgLocation,
): Promise<void> {
  if (session.state === "awaiting_checkin_location") return doCheckin(chatId, worker, session, location);
  if (session.state === "awaiting_checkout_location") return doCheckout(chatId, worker, session, location);
  await send(chatId, "Use /checkin or /checkout first.", { reply_markup: REMOVE_KEYBOARD });
}

async function doCheckin(
  chatId: number,
  worker: Worker,
  session: Session,
  location: TgLocation,
): Promise<void> {
  const existing = await openAttendance(worker.id);
  if (existing) {
    await saveSession(session, { state: "idle" });
    await send(
      chatId,
      `Already checked in since ${await fmtTime(existing.check_in_at)}. Use /checkout first.`,
      { reply_markup: REMOVE_KEYBOARD },
    );
    return;
  }

  const projectId = session.draft.project_id ?? worker.default_project_id ?? null;
  const { data, error } = await supabase
    .from("attendance")
    .insert({
      worker_id: worker.id,
      project_id: projectId,
      in_lat: location.latitude,
      in_lng: location.longitude,
    })
    .select("id, check_in_at")
    .single();
  if (error) throw error;

  await saveSession(session, { state: "idle" });

  const project = projectId ? await getProject(projectId) : null;
  await send(
    chatId,
    `✅ Checked in · ${await fmtTime(data.check_in_at)} · ${project ? project.code : "no project"}`,
    { reply_markup: REMOVE_KEYBOARD },
  );
}

async function doCheckout(
  chatId: number,
  worker: Worker,
  session: Session,
  location: TgLocation,
): Promise<void> {
  const open = await openAttendance(worker.id);
  if (!open) {
    await saveSession(session, { state: "idle" });
    await send(chatId, "You're not checked in. Use /checkin.", { reply_markup: REMOVE_KEYBOARD });
    return;
  }

  const { flagDistanceKm } = await getSettings();
  const distance = haversineMeters(open.in_lat, open.in_lng, location.latitude, location.longitude);
  const farApart = distance >= flagDistanceKm * 1000;
  const checkOutAt = new Date();

  const { error } = await supabase
    .from("attendance")
    .update({
      check_out_at: checkOutAt.toISOString(),
      out_lat: location.latitude,
      out_lng: location.longitude,
      distance_m: distance,
      ...(farApart
        ? {
          flags: Array.from(new Set([...(open.flags ?? []), "far_apart"])),
          review_status: "pending",
        }
        : {}),
    })
    .eq("id", open.id);
  if (error) throw error;

  await saveSession(session, { state: "idle" });

  const worked = fmtDuration(checkOutAt.getTime() - new Date(open.check_in_at).getTime());
  await send(chatId, `✅ Checked out · ${await fmtTime(checkOutAt)} · on site ${worked}`, {
    reply_markup: REMOVE_KEYBOARD,
  });
}

// ---------------------------------------------------------------- media intake

function extToMime(ext: string): string {
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    mp4: "video/mp4",
    mov: "video/quicktime",
    pdf: "application/pdf",
  };
  return map[ext] ?? "application/octet-stream";
}

function extFromMime(mime?: string | null): string | null {
  if (!mime) return null;
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "application/pdf": "pdf",
  };
  if (map[mime]) return map[mime];
  const sub = mime.split("/")[1];
  if (!sub) return null;
  const clean = sub.split(";")[0].replace(/[^a-z0-9]/gi, "").toLowerCase();
  return clean || null;
}

function extFromFilename(name?: string | null): string | null {
  if (!name || !name.includes(".")) return null;
  const ext = name.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "");
  return ext && ext.length <= 8 ? ext : null;
}

function extractMedia(message: TgMessage): MediaDescriptor | null {
  const group = message.media_group_id ?? null;

  if (message.photo?.length) {
    const largest = message.photo.reduce((a, b) =>
      (b.file_size ?? b.width * b.height) > (a.file_size ?? a.width * a.height) ? b : a
    );
    return {
      media_type: "photo",
      telegram_file_id: largest.file_id,
      mime_type: "image/jpeg",
      file_size: largest.file_size ?? null,
      width: largest.width ?? null,
      height: largest.height ?? null,
      media_group_id: group,
      file_name: null,
      ext: "jpg",
    };
  }

  if (message.video) {
    const v = message.video;
    return {
      media_type: "video",
      telegram_file_id: v.file_id,
      mime_type: v.mime_type ?? "video/mp4",
      file_size: v.file_size ?? null,
      width: v.width ?? null,
      height: v.height ?? null,
      media_group_id: group,
      file_name: v.file_name ?? null,
      ext: extFromMime(v.mime_type) ?? extFromFilename(v.file_name) ?? "mp4",
    };
  }

  if (message.document) {
    const d = message.document;
    return {
      media_type: "document",
      telegram_file_id: d.file_id,
      mime_type: d.mime_type ?? null,
      file_size: d.file_size ?? null,
      width: null,
      height: null,
      media_group_id: group,
      file_name: d.file_name ?? null,
      ext: extFromFilename(d.file_name) ?? extFromMime(d.mime_type) ?? "bin",
    };
  }

  return null;
}

/**
 * Fetch a report only if it belongs to the given worker. The webhook writes as
 * service role, so this ownership check is the authorization layer for every
 * report-mutating callback — callback data is attacker-controllable.
 */
async function ownedReport(reportId: number, workerId: number): Promise<Report | null> {
  const { data, error } = await supabase
    .from("reports")
    .select("id, project_id, worker_id, report_date, note")
    .eq("id", reportId)
    .eq("worker_id", workerId)
    .maybeSingle();
  if (error) throw error;
  return (data as Report) ?? null;
}

const NOT_YOURS = "That report was filed by someone else — only they can edit it.";

/** Report that already owns this album. */
async function findAlbumReport(groupId: string): Promise<Report | null> {
  const { data, error } = await supabase
    .from("reports")
    .select("id, project_id, worker_id, report_date, note")
    .eq("album_group_id", groupId)
    .maybeSingle();
  if (error) throw error;
  return (data as Report) ?? null;
}

const RESEND_WARNING = "⚠️ That file couldn't be saved — please resend it.";

async function handleIncomingMedia(
  chatId: number,
  worker: Worker,
  session: Session,
  media: MediaDescriptor,
  caption: string | null,
): Promise<void> {
  // Part 2+ of an album whose report already exists → attach silently.
  if (media.media_group_id) {
    const report = await findAlbumReport(media.media_group_id);
    if (report) {
      const ok = await storeMedia(report, media);
      if (!ok) await send(chatId, RESEND_WARNING);
      if (caption && report.note === null) {
        await supabase.from("reports").update({ note: caption }).eq("id", report.id);
      }
      return;
    }
  }

  const projectId = session.draft.project_id ?? worker.default_project_id ?? null;

  if (projectId === null) {
    // Persist pending media as table rows — concurrent album parts INSERT
    // instead of racing over one session-draft blob.
    const { error } = await supabase
      .from("pending_media")
      .insert({ chat_id: chatId, media, caption });
    if (error) throw error;

    if (session.state !== "choosing_project_for_media") {
      const rows = await projectKeyboard(worker.id, "pjm");
      if (!rows) {
        await supabase.from("pending_media").delete().eq("chat_id", chatId);
        await send(chatId, "No active projects yet. Ask your admin to set one up.");
        return;
      }
      await saveSession(session, {
        state: "choosing_project_for_media",
        draft: { ...session.draft, pending_group: media.media_group_id },
      });
      await send(chatId, "Which site is this for?", { reply_markup: { inline_keyboard: rows } });
    }
    return;
  }

  const { report, created } = await createReport(
    worker.id,
    projectId,
    caption,
    media.media_group_id,
  );
  const ok = await storeMedia(report, media);
  if (!ok) {
    if (created && !media.media_group_id) {
      // solo report with zero stored files is noise — remove it
      await supabase.from("reports").delete().eq("id", report.id);
    }
    await send(chatId, RESEND_WARNING);
    return;
  }
  if (created) {
    const project = await getProject(projectId);
    await sendReportConfirmation(chatId, report, project?.code ?? "site");
  } else if (caption && report.note === null) {
    await supabase.from("reports").update({ note: caption }).eq("id", report.id);
  }
}

/**
 * Create a report; for albums the unique album_group_id makes this race-safe —
 * the losing concurrent insert gets 23505 and adopts the winner's report.
 */
async function createReport(
  workerId: number,
  projectId: number,
  note: string | null,
  albumGroupId: string | null = null,
): Promise<{ report: Report; created: boolean }> {
  const { data, error } = await supabase
    .from("reports")
    .insert({
      project_id: projectId,
      worker_id: workerId,
      report_date: await localDate(),
      note: note && note.trim() ? note.trim() : null,
      album_group_id: albumGroupId,
    })
    .select("id, project_id, worker_id, report_date, note")
    .single();
  if (!error) return { report: data as Report, created: true };

  if (error.code === "23505" && albumGroupId) {
    const existing = await findAlbumReport(albumGroupId);
    if (existing) return { report: existing, created: false };
  }
  throw error;
}

/**
 * Download from Telegram, upload to storage, record the row.
 * Returns false on any failure so callers can tell the worker instead of
 * silently confirming a report whose file was never archived.
 */
async function storeMedia(report: Report, media: MediaDescriptor): Promise<boolean> {
  try {
    const { botToken } = await getConfig();

    const file = await tg("getFile", { file_id: media.telegram_file_id });
    if (!file?.file_path) {
      console.error("getFile returned no file_path", media.telegram_file_id);
      return false;
    }

    const res = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
    if (!res.ok) {
      console.error("telegram file download failed", res.status, media.telegram_file_id);
      return false;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());

    const contentType = media.mime_type ?? extToMime(media.ext);
    const storagePath =
      `project_${report.project_id}/${report.report_date}/${report.id}/${crypto.randomUUID()}.${media.ext}`;

    const upload = await supabase.storage
      .from("site-media")
      .upload(storagePath, bytes, { contentType, upsert: false });
    if (upload.error) {
      console.error("storage upload failed", upload.error);
      return false;
    }

    const { error } = await supabase.from("report_media").insert({
      report_id: report.id,
      storage_path: storagePath,
      media_type: media.media_type,
      telegram_file_id: media.telegram_file_id,
      mime_type: contentType,
      file_size: media.file_size ?? bytes.byteLength,
      width: media.width,
      height: media.height,
      media_group_id: media.media_group_id,
      file_name: media.file_name,
    });
    if (error) {
      console.error("report_media insert failed", error);
      return false;
    }
    return true;
  } catch (err) {
    console.error("storeMedia threw", err);
    return false;
  }
}

// ---------------------------------------------------------------- text states

async function saveNoteFromText(
  chatId: number,
  worker: Worker,
  session: Session,
  text: string,
): Promise<void> {
  const reportId = session.draft.report_id;
  if (!reportId) {
    await saveSession(session, { state: "idle", draft: resetDraft(session.draft) });
    await send(chatId, "That report is no longer open. Send the media again to start over.");
    return;
  }

  const { error } = await supabase
    .from("reports")
    .update({ note: text })
    .eq("id", reportId)
    .eq("worker_id", worker.id);
  if (error) throw error;

  await saveSession(session, { state: "idle", draft: resetDraft(session.draft) });
  await send(chatId, "✅ Note saved.");
}

/** Accepts YYYY-MM-DD or DD/MM/YYYY; returns an ISO date or null. */
function parseDate(input: string): string | null {
  const text = input.trim();
  let y: number, m: number, d: number;

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);

  if (iso) {
    y = +iso[1];
    m = +iso[2];
    d = +iso[3];
  } else if (dmy) {
    d = +dmy[1];
    m = +dmy[2];
    y = +dmy[3];
  } else {
    return null;
  }

  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(m)}-${pad(d)}`;
}

async function saveDateFromText(
  chatId: number,
  worker: Worker,
  session: Session,
  text: string,
): Promise<void> {
  const reportId = session.draft.report_id;
  if (!reportId) {
    await saveSession(session, { state: "idle", draft: resetDraft(session.draft) });
    await send(chatId, "That report is no longer open. Send the media again to start over.");
    return;
  }

  const parsed = parseDate(text);
  if (!parsed) {
    await send(chatId, "I couldn't read that date. Use 2026-08-03 or 03/08/2026.");
    return;
  }

  const { error } = await supabase
    .from("reports")
    .update({ report_date: parsed })
    .eq("id", reportId)
    .eq("worker_id", worker.id);
  if (error) throw error;

  await saveSession(session, { state: "idle", draft: resetDraft(session.draft) });
  await send(chatId, `✅ Date set to ${await fmtDate(parsed)}.`);
}

// ---------------------------------------------------------------- callbacks

async function handleCallbackQuery(query: TgCallbackQuery): Promise<void> {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const chatType = query.message?.chat?.type;
  if (!chatId || !query.data || (chatType && chatType !== "private")) {
    await answerCallback(query.id);
    return;
  }

  const session = await getSession(chatId);
  const worker = await findWorker(query.from.id);

  if (!worker || worker.status !== "active") {
    await answerCallback(query.id, worker ? "Your account isn't active." : "Please register first.");
    return;
  }
  await answerCallback(query.id);

  const parts = query.data.split(":");
  const action = parts[0];

  // every r* action edits a report → ownership is checked before dispatch
  const reportActions = ["rn", "rd", "rdd", "rdt", "rp", "rpp"];
  if (reportActions.includes(action)) {
    const report = await ownedReport(Number(parts[1]), worker.id);
    if (!report) {
      await send(chatId, NOT_YOURS);
      return;
    }
  }

  switch (action) {
    case "pj":
      return cbPickStickyProject(chatId, messageId, session, Number(parts[1]));
    case "pjm":
      return cbPickProjectForMedia(chatId, messageId, worker, session, Number(parts[1]));
    case "rn":
      return cbAskNote(chatId, session, Number(parts[1]));
    case "rd":
      return cbShowDateOptions(chatId, messageId, Number(parts[1]));
    case "rdd":
      return cbSetRelativeDate(chatId, messageId, Number(parts[1]), Number(parts[2]));
    case "rdt":
      return cbAskTypedDate(chatId, session, Number(parts[1]));
    case "rp":
      return cbShowProjectOptions(chatId, messageId, worker, Number(parts[1]));
    case "rpp":
      return cbSetReportProject(chatId, messageId, Number(parts[1]), Number(parts[2]));
    default:
      console.error("unknown callback data", query.data);
  }
}

async function cbPickStickyProject(
  chatId: number,
  messageId: number | undefined,
  session: Session,
  projectId: number,
): Promise<void> {
  const project = await getProject(projectId);
  if (!project) {
    await send(chatId, "That project no longer exists.");
    return;
  }
  await saveSession(session, { draft: { ...session.draft, project_id: projectId } });
  if (messageId) await editKeyboard(chatId, messageId, []);
  await send(chatId, `Active project: ${project.code} — ${project.name}`);
}

async function cbPickProjectForMedia(
  chatId: number,
  messageId: number | undefined,
  worker: Worker,
  session: Session,
  projectId: number,
): Promise<void> {
  const project = await getProject(projectId);
  if (!project) {
    await send(chatId, "That project no longer exists.");
    return;
  }

  const { data: pendRows, error: pendErr } = await supabase
    .from("pending_media")
    .select("id, media, caption")
    .eq("chat_id", chatId)
    .order("id");
  if (pendErr) throw pendErr;
  const pending = (pendRows ?? []) as { id: number; media: MediaDescriptor; caption: string | null }[];

  if (messageId) await editKeyboard(chatId, messageId, []);

  if (pending.length === 0) {
    await saveSession(session, {
      state: "idle",
      draft: { ...resetDraft(session.draft), project_id: projectId },
    });
    await send(chatId, `Active project: ${project.code} — ${project.name}`);
    return;
  }

  const caption = pending.find((p) => p.caption)?.caption ?? null;
  const group = session.draft.pending_group ??
    pending.find((p) => p.media.media_group_id)?.media.media_group_id ?? null;

  const { report, created } = await createReport(worker.id, projectId, caption, group);

  // bounded parallelism: 3 at a time keeps a big album inside the wall clock
  let stored = 0;
  for (let i = 0; i < pending.length; i += 3) {
    const results = await Promise.all(
      pending.slice(i, i + 3).map((p) => storeMedia(report, p.media)),
    );
    stored += results.filter(Boolean).length;
  }
  await supabase.from("pending_media").delete().eq("chat_id", chatId);

  await saveSession(session, {
    state: "idle",
    draft: { project_id: projectId, report_id: report.id },
  });

  if (stored === 0) {
    if (created) await supabase.from("reports").delete().eq("id", report.id);
    await send(chatId, "⚠️ None of the files could be saved — please resend them.");
    return;
  }
  if (created) await sendReportConfirmation(chatId, report, project.code);
  if (stored < pending.length) {
    await send(
      chatId,
      `⚠️ ${pending.length - stored} of ${pending.length} files couldn't be saved — please resend them.`,
    );
  }
}

async function cbAskNote(chatId: number, session: Session, reportId: number): Promise<void> {
  await saveSession(session, {
    state: "adding_note",
    draft: { ...session.draft, report_id: reportId },
  });
  await send(chatId, "Send the note for this report.");
}

async function cbShowDateOptions(
  chatId: number,
  messageId: number | undefined,
  reportId: number,
): Promise<void> {
  const rows: InlineButton[][] = [
    [
      { text: "Today", callback_data: `rdd:${reportId}:0` },
      { text: "Yesterday", callback_data: `rdd:${reportId}:1` },
    ],
    [{ text: "✍️ Type date", callback_data: `rdt:${reportId}` }],
  ];
  if (messageId) await editKeyboard(chatId, messageId, rows);
  else await send(chatId, "Which date?", { reply_markup: { inline_keyboard: rows } });
}

async function cbSetRelativeDate(
  chatId: number,
  messageId: number | undefined,
  reportId: number,
  daysBack: number,
): Promise<void> {
  const date = await localDate(Number.isFinite(daysBack) ? daysBack : 0);
  const { error } = await supabase.from("reports").update({ report_date: date }).eq("id", reportId);
  if (error) throw error;
  if (messageId) await editKeyboard(chatId, messageId, reportButtons(reportId));
  await send(chatId, `✅ Date set to ${await fmtDate(date)}.`);
}

async function cbAskTypedDate(chatId: number, session: Session, reportId: number): Promise<void> {
  await saveSession(session, {
    state: "typing_date",
    draft: { ...session.draft, report_id: reportId },
  });
  await send(chatId, "Send the date as 2026-08-03 or 03/08/2026.");
}

async function cbShowProjectOptions(
  chatId: number,
  messageId: number | undefined,
  worker: Worker,
  reportId: number,
): Promise<void> {
  const rows = await projectKeyboard(worker.id, "rpp", reportId);
  if (!rows) {
    await send(chatId, "No active projects yet. Ask your admin to set one up.");
    return;
  }
  if (messageId) await editKeyboard(chatId, messageId, rows);
  else await send(chatId, "Which site?", { reply_markup: { inline_keyboard: rows } });
}

async function cbSetReportProject(
  chatId: number,
  messageId: number | undefined,
  reportId: number,
  projectId: number,
): Promise<void> {
  const project = await getProject(projectId);
  if (!project) {
    await send(chatId, "That project no longer exists.");
    return;
  }
  const { error } = await supabase
    .from("reports")
    .update({ project_id: projectId })
    .eq("id", reportId);
  if (error) throw error;
  if (messageId) await editKeyboard(chatId, messageId, reportButtons(reportId));
  await send(chatId, `✅ Moved to ${project.code} — ${project.name}.`);
}

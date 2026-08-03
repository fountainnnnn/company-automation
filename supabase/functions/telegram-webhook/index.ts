// Telegram bot webhook — construction-site reporting + attendance.
//
// Stateless: every update re-resolves the worker and the chat session from the
// database. Secrets and settings are cached in module scope for the lifetime of
// the isolate. Always answers 200 for authenticated updates so Telegram never
// enters a retry storm because of an internal failure.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { looksLikeTimesheet, type ParsedTimesheet, parseTimesheet } from "./parser.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// ---------------------------------------------------------------- types

interface TgUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TgChat {
  id: number;
  type?: string;
  title?: string;
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
  chat: TgChat;
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

/** Only the fields we need: who the bot became in which chat. */
interface TgChatMemberUpdated {
  chat: TgChat;
  from?: TgUser;
  new_chat_member?: { user?: TgUser; status?: string };
}

interface TgUpdate {
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
  my_chat_member?: TgChatMemberUpdated;
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

/** A crew group chat bound to one site; everything posted there files to it. */
interface GroupLink {
  chat_id: number;
  project_id: number;
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
  /** Text-only record waiting for its site pick. */
  pending_note?: string;
  /** Parsed timesheet awaiting confirmation, plus the message it came from. */
  timesheet?: ParsedTimesheet;
  timesheet_raw?: string;
}

type SessionState =
  | "idle"
  | "registering"
  | "awaiting_checkin_location"
  | "awaiting_checkout_location"
  | "choosing_project_for_media"
  | "adding_note"
  | "typing_date"
  | "awaiting_record"
  | "awaiting_timesheet"
  | "ts_typing_date"
  | "ts_typing_team"
  | "ts_typing_loc";

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

/**
 * Rewrite the prompt into its own answer. Telegram never echoes which inline
 * button was tapped, so blanking the keyboard leaves a question hanging with no
 * visible reply. Replacing the text keeps the chat readable as a transcript.
 */
function resolvePrompt(chatId: number, messageId: number, text: string) {
  return tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: { inline_keyboard: [] },
  });
}

/**
 * Acknowledge without speaking. In a crew group a "✅ saved" line per photo is
 * noise that buries the crew's own conversation, so the receipt is a reaction on
 * their message. `tg` already swallows failures — a missing reaction is silent.
 */
function react(chatId: number, messageId: number, emoji: string) {
  return tg("setMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: "emoji", emoji }],
  });
}

/** Reply threaded to a specific message — for groups, where context is shared. */
function replyTo(
  chatId: number,
  messageId: number,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return send(chatId, text, { reply_parameters: { message_id: messageId }, ...extra });
}

const LOCATION_KEYBOARD = {
  keyboard: [[{ text: "📍 Share location", request_location: true }]],
  one_time_keyboard: true,
  resize_keyboard: true,
};


/**
 * The standing button bar. Workers on site should never have to remember a
 * slash command — every action is one tap, and the bar stays put between
 * messages (is_persistent) so the chat never dead-ends.
 */
const MAIN_KEYBOARD = {
  keyboard: [
    // site work first — it's the everyday job; attendance is its own thing
    [{ text: "📷 Send records" }, { text: "📋 Timesheet" }],
    [{ text: "🕘 Check in" }, { text: "🕔 Check out" }],
    [{ text: "ℹ️ Status" }, { text: "❓ Help" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

/** Map a tapped button back to the command it stands for. */
function buttonCommand(text: string): string | null {
  const key = text.replace(/[^a-z]/gi, "").toLowerCase();
  const map: Record<string, string> = {
    sendrecords: "send",
    checkin: "checkin",
    checkout: "checkout",
    timesheet: "timesheet",
    status: "status",
    help: "help",
  };
  return map[key] ?? null;
}

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
function resetDraft(_draft: Draft): Draft {
  return {};
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

// Three independent jobs. Workers kept assuming one had to precede another, so
// the help says outright that they don't.
const HELP_TEXT = [
  "📷 SITE RECORDS",
  "Send photos, videos, files — or just type what happened.",
  "I'll ask which site it's for. A caption becomes the note.",
  "",
  "🕘 ATTENDANCE",
  "Check in / Check out share your location to log your hours.",
  "This is separate — you don't need to check in to send photos.",
  "",
  "📋 TIMESHEET",
  "Paste the day's crew list, e.g.",
  "03/08 Team 2 Tuas",
  "(W101 - 8)",
  "(W104 - MC)",
  "",
  "Use the buttons below — no commands to remember.",
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

/**
 * Always ask for a description after files land, but never block on it — an
 * unlabelled photo is far worse than an empty note, and a worker on scaffolding
 * needs one tap to move on. Typing the answer or tapping Skip both end here.
 */
async function askForDetails(
  chatId: number,
  session: Session,
  report: Report,
  code: string,
  fileCount: number,
): Promise<void> {
  await saveSession(session, {
    state: "adding_note",
    draft: { ...session.draft, report_id: report.id },
  });
  const files = `${fileCount} file${fileCount === 1 ? "" : "s"}`;
  await send(
    chatId,
    `✅ ${files} saved → ${code} · ${await fmtDate(report.report_date)}\n\n` +
      `📝 What's this about? Type a short description — or tap Skip.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "⏭ Skip — no description", callback_data: `nskip:${report.id}` }],
          // wrong site is caught here, at the moment they can still see the batch
          [{ text: "📁 Wrong site? Move it", callback_data: `rp:${report.id}` }],
        ],
      },
    },
  );
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
  if (update.my_chat_member) return handleMyChatMember(update.my_chat_member);
  if (update.message) return handleMessage(update.message);
  return Promise.resolve();
}

// ---------------------------------------------------------------- messages in

async function handleMessage(message: TgMessage): Promise<void> {
  const from = message.from;
  if (!from || !message.chat?.id) return;
  if (isGroupChat(message.chat)) return handleGroupMessage(message, from);
  // Anything else (channels) has no sender to attribute work to.
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

  // A tapped button from the standing menu is just its command by another name.
  // Checked after location/media so it can never swallow a real submission, but
  // ahead of the state machine: the bar is visible in every state, and a tap
  // that silently became a note is how people got stuck mid-flow. A typed
  // description that reads exactly like a button label is the accepted loss.
  const tapped = buttonCommand(text);
  if (tapped) return handleCommand(tapped, chatId, worker, session);

  switch (session.state) {
    case "awaiting_checkin_location":
    case "awaiting_checkout_location":
      await send(chatId, "Location is required — please tap the 📍 button.", {
        reply_markup: LOCATION_KEYBOARD,
      });
      return;
    case "awaiting_record":
      // no media came — the typed text IS the record
      return startTextRecord(chatId, worker, session, text);
    case "adding_note":
      return saveNoteFromText(chatId, worker, session, text);
    case "typing_date":
      return saveDateFromText(chatId, worker, session, text);
    case "choosing_project_for_media":
      await send(chatId, "Pick a project from the buttons above first.");
      return;
    case "awaiting_timesheet":
      return startTimesheet(chatId, session, text);
    case "ts_typing_date":
      return tsTypedDate(chatId, session, text);
    case "ts_typing_team":
      return tsTypedTeam(chatId, session, text);
    case "ts_typing_loc":
      return tsTypedLocation(chatId, session, text);
    default:
      // a pasted crew list is a timesheet even without the command
      if (looksLikeTimesheet(text)) return startTimesheet(chatId, session, text);
      await send(chatId, HELP_TEXT);
  }
}

/**
 * An admin can pre-register someone by @username before that person has ever
 * messaged the bot (Telegram won't resolve a username to an id until then).
 * On first contact we claim that row rather than creating a pending duplicate,
 * so a pre-approved worker is usable immediately.
 */
async function claimPreregistered(from: TgUser): Promise<Worker | null> {
  if (!from.username) return null;

  const { data, error } = await supabase
    .from("workers")
    .update({ telegram_user_id: from.id, telegram_username: from.username })
    .is("telegram_user_id", null)
    .ilike("telegram_username", from.username)
    .select("id, full_name, telegram_user_id, telegram_username, status, default_project_id")
    .maybeSingle();

  if (error) {
    console.error("preregistration claim failed", error);
    return null;
  }
  return (data as Worker) ?? null;
}

async function handleUnregistered(
  chatId: number,
  session: Session,
  message: TgMessage,
  from: TgUser,
): Promise<void> {
  const claimed = await claimPreregistered(from);
  if (claimed) {
    await saveSession(session, { worker_id: claimed.id, state: "idle", draft: {} });
    await send(
      chatId,
      claimed.status === "active"
        ? `Welcome, ${claimed.full_name}. Your account is already set up.\n\n${HELP_TEXT}`
        : `Welcome, ${claimed.full_name}. Your account is awaiting admin approval.`,
    );
    return;
  }

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

// ---------------------------------------------------------------- group mode
//
// A crew lives in one group per site and posts there all day. Two hard rules:
//
//  1. NEVER touch chat_sessions. A session is keyed by chat, so in a group it is
//     shared by everyone in it — any state read there cross-attributes one
//     worker's flow to another. Group handling is therefore fully stateless:
//     everything it needs comes from the message and from group_links.
//  2. NEVER ask a question and almost never reply. Receipts are reactions on the
//     sender's own message; a reply is reserved for the cases where staying
//     silent would lose work (a failed upload, an unlinked group, a duplicate
//     timesheet).

/** How long one sender's loose photos keep landing in the same report. */
const GROUP_REPORT_WINDOW_MS = 60 * 60_000;

const GROUP_GREETING = "I'll archive photos posted here. Which site is this group for?";

const GROUP_LINK_PROMPT = "📁 I'm not filing this group anywhere yet. Which site is it for?";

const GROUP_HELP = [
  "📷 Photos, videos and files posted here are archived to this group's site — just post, I stay quiet (👍 = saved).",
  "/link to set the site · /unlink to stop · check in/out is personal, DM me.",
].join("\n");

const GROUP_DM_ONLY = "Check-in is personal — do it in a DM with me 👉 t.me/CLAutomationBot";

const GROUP_RESEND_WARNING =
  "⚠️ Couldn't save that file — resend it? (Videos over 20 MB are too big for me; send a smaller clip.)";

const GROUP_NOT_A_WORKER = "Only registered workers can link this group.";

function isGroupChat(chat: TgChat): boolean {
  return chat.type === "group" || chat.type === "supergroup";
}

async function getGroupLink(chatId: number): Promise<GroupLink | null> {
  const { data, error } = await supabase
    .from("group_links")
    .select("chat_id, project_id")
    .eq("chat_id", chatId)
    .maybeSingle();
  if (error) throw error;
  return (data as GroupLink) ?? null;
}

/** Every active site, as `gl:` picker rows. Group pickers are worker-agnostic:
 * the group belongs to a site, not to whoever happens to tap. */
async function groupLinkKeyboard(): Promise<InlineButton[][] | null> {
  const { data, error } = await supabase
    .from("projects")
    .select("id, code, name")
    .eq("status", "active")
    .order("code");
  if (error) throw error;
  const projects = (data ?? []) as Project[];
  if (projects.length === 0) return null;
  return projects.map((p) => [
    { text: `${p.code} — ${p.name}`, callback_data: `gl:${p.id}` },
  ]);
}

/**
 * The sender of a group message, creating a pending worker if we've never seen
 * them. A photo of a live defect is worth more than a tidy worker table, so an
 * unregistered sender is never a reason to drop a file — the admin approves the
 * row later and the reports are already attributed to it.
 */
async function resolveGroupSender(from: TgUser): Promise<Worker> {
  const existing = await findWorker(from.id);
  if (existing) return existing;

  const name = `${from.first_name ?? ""}${from.last_name ? ` ${from.last_name}` : ""}`.trim();
  const fullName = name || (from.username ? `@${from.username}` : `Telegram ${from.id}`);

  const { data, error } = await supabase
    .from("workers")
    .insert({
      full_name: fullName.slice(0, 120),
      telegram_user_id: from.id,
      telegram_username: from.username ?? null,
      status: "pending",
    })
    .select("id, full_name, telegram_user_id, telegram_username, status, default_project_id")
    .single();
  if (!error) return data as Worker;

  // two album parts raced the same first-ever sender → adopt the winner's row
  if (error.code === "23505") {
    const raced = await findWorker(from.id);
    if (raced) return raced;
  }
  throw error;
}

async function handleGroupMessage(message: TgMessage, from: TgUser): Promise<void> {
  if (from.is_bot) return; // our own posts and other bots are not site records

  const link = await getGroupLink(message.chat.id);

  const command = parseCommand(message.text);
  if (command) return handleGroupCommand(command, message, from, link);

  const media = extractMedia(message);
  if (media) return handleGroupMedia(message, from, link, media);

  if (!link) return;

  // Crew chatter is not a report. The one exception is a pasted crew list —
  // that is a document someone would otherwise have to re-send in a DM.
  const text = (message.text ?? "").trim();
  if (text && looksLikeTimesheet(text)) return groupTimesheet(message, from, link, text);
}

async function handleGroupCommand(
  command: string,
  message: TgMessage,
  from: TgUser,
  link: GroupLink | null,
): Promise<void> {
  const chatId = message.chat.id;

  switch (command) {
    case "link":
      return groupStartLink(message, from);
    case "unlink":
      return groupUnlink(message, from, link);
    case "checkin":
    case "checkout":
      await replyTo(chatId, message.message_id, GROUP_DM_ONLY);
      return;
    case "status":
    case "help":
    case "start":
      await send(chatId, GROUP_HELP);
      return;
    default:
      // Groups are full of commands meant for other bots — never answer them.
      return;
  }
}

async function groupStartLink(message: TgMessage, from: TgUser): Promise<void> {
  const chatId = message.chat.id;
  const worker = await findWorker(from.id);
  if (!worker || worker.status !== "active") {
    await replyTo(chatId, message.message_id, GROUP_NOT_A_WORKER);
    return;
  }
  const rows = await groupLinkKeyboard();
  if (!rows) {
    await replyTo(chatId, message.message_id, "No active projects yet. Ask your admin to set one up.");
    return;
  }
  await send(chatId, "📁 Which site is this group for?", {
    reply_markup: { inline_keyboard: rows },
  });
}

async function groupUnlink(
  message: TgMessage,
  from: TgUser,
  link: GroupLink | null,
): Promise<void> {
  const chatId = message.chat.id;
  const worker = await findWorker(from.id);
  if (!worker || worker.status !== "active") {
    await replyTo(chatId, message.message_id, GROUP_NOT_A_WORKER);
    return;
  }
  if (!link) {
    await replyTo(chatId, message.message_id, "This group isn't linked to a site.");
    return;
  }
  const { error } = await supabase.from("group_links").delete().eq("chat_id", chatId);
  if (error) throw error;
  await replyTo(chatId, message.message_id, "🔌 Unlinked — I'll stop archiving posts here.");
}

/**
 * Bot added to (or promoted in) a group: ask once which site it is for. Skipped
 * when the group is already linked, so a later promotion to admin doesn't
 * re-open a question that has been answered.
 */
async function handleMyChatMember(update: TgChatMemberUpdated): Promise<void> {
  const chat = update.chat;
  if (!chat?.id || !isGroupChat(chat)) return;

  const status = update.new_chat_member?.status;
  if (status !== "member" && status !== "administrator") return;
  if (await getGroupLink(chat.id)) return;

  const rows = await groupLinkKeyboard();
  if (!rows) {
    await send(chat.id, `${GROUP_GREETING}\n\nNo active sites yet — ask your admin to add one, then /link.`);
    return;
  }
  await send(chat.id, GROUP_GREETING, { reply_markup: { inline_keyboard: rows } });
}

/**
 * The report a loose (non-album) photo from this sender belongs to: their newest
 * one for this site inside the window. Six photos posted across twenty minutes
 * are one work update, not six rows on the dashboard. Album parts are excluded —
 * they group by album_group_id instead.
 */
async function findRecentGroupReport(
  workerId: number,
  projectId: number,
): Promise<Report | null> {
  const since = new Date(Date.now() - GROUP_REPORT_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from("reports")
    .select("id, project_id, worker_id, report_date, note")
    .eq("worker_id", workerId)
    .eq("project_id", projectId)
    .is("album_group_id", null)
    .gt("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data?.[0] as Report) ?? null;
}

/** Append a later caption instead of overwriting: both sentences were typed. */
async function appendGroupNote(report: Report, caption: string): Promise<void> {
  const note = report.note ? `${report.note}\n${caption}` : caption;
  const { error } = await supabase.from("reports").update({ note }).eq("id", report.id);
  if (error) throw error;
  report.note = note;
}

async function handleGroupMedia(
  message: TgMessage,
  from: TgUser,
  link: GroupLink | null,
  media: MediaDescriptor,
): Promise<void> {
  const chatId = message.chat.id;
  const caption = message.caption?.trim() || null;

  if (!link) {
    // One clear prompt, never one per album part: a lone photo asks outright,
    // and an album asks on its captioned part (Telegram carries the album
    // caption on exactly one message). The rest only get a 🤔 so an eight-photo
    // batch can't produce eight identical questions.
    if (media.media_group_id && !caption) {
      await react(chatId, message.message_id, "🤔");
      return;
    }
    const rows = await groupLinkKeyboard();
    if (!rows) {
      await replyTo(chatId, message.message_id, "No active projects yet. Ask your admin to set one up.");
      return;
    }
    await replyTo(chatId, message.message_id, GROUP_LINK_PROMPT, {
      reply_markup: { inline_keyboard: rows },
    });
    return;
  }

  const sender = await resolveGroupSender(from);

  let report: Report | null = null;
  let created = false;

  if (media.media_group_id) {
    report = await findAlbumReport(media.media_group_id);
  } else {
    report = await findRecentGroupReport(sender.id, link.project_id);
  }

  if (report) {
    if (caption) await appendGroupNote(report, caption);
  } else {
    const fresh = await createReport(
      sender.id,
      link.project_id,
      caption,
      media.media_group_id ?? null,
    );
    report = fresh.report;
    created = fresh.created;
    // lost the album race: the winner's report may already carry a caption
    if (!created && caption && report.note !== caption) await appendGroupNote(report, caption);
  }

  const ok = await storeMedia(report, media);
  if (!ok) {
    // never leave an empty report behind for a file that never landed
    if (created) await supabase.from("reports").delete().eq("id", report.id);
    await replyTo(chatId, message.message_id, GROUP_RESEND_WARNING);
    return;
  }
  await react(chatId, message.message_id, "👍");
}

/**
 * A crew list pasted into the group is saved as-is. No confirm card: the card is
 * a private back-and-forth, and in a group it would be answerable by anyone.
 * Corrections happen in a DM, which is what the duplicate reply points at.
 */
async function groupTimesheet(
  message: TgMessage,
  from: TgUser,
  link: GroupLink,
  text: string,
): Promise<void> {
  const chatId = message.chat.id;
  const sheet = parseTimesheet(text, await localDate(), await tz());
  if (sheet.entries.length === 0) return;

  const workDate = sheet.workDate ?? await localDate();
  const team = sheet.teamNumber ?? "—";

  const existing = await findExistingTimesheet(workDate, sheet.teamNumber);
  if (existing) {
    await replyTo(
      chatId,
      message.message_id,
      `Already filed for Team ${team} on ${await fmtDate(workDate)} — DM me to replace it.`,
    );
    return;
  }

  const sender = await resolveGroupSender(from);
  const { data, error } = await supabase
    .from("timesheets")
    .insert({
      work_date: workDate,
      team_number: sheet.teamNumber,
      location: sheet.location,
      project_id: link.project_id,
      submitted_by: sender.id,
      raw_text: text.slice(0, 4000),
    })
    .select("id")
    .single();
  if (error) throw error;

  const rows = sheet.entries.map((e) => ({
    timesheet_id: data.id,
    worker_code: e.workerCode,
    hours: e.hours,
    absence_reason: e.absenceReason,
    role: e.role,
  }));
  const entriesInsert = await supabase.from("timesheet_entries").insert(rows);
  if (entriesInsert.error) {
    await supabase.from("timesheets").delete().eq("id", data.id);
    throw entriesInsert.error;
  }

  const lines = [
    `✅ Timesheet saved · ${await fmtDate(workDate)} · Team ${team} · ${rows.length} entries`,
  ];
  if (sheet.unparsed.length > 0) {
    lines.push(`⚠️ Couldn't read: ${sheet.unparsed.join(" | ").slice(0, 300)}`);
  }
  await replyTo(chatId, message.message_id, lines.join("\n"));
}

/**
 * Group taps. Only the site picker exists here, and it deliberately does not
 * read or write a session — the tapper is one member of many.
 */
async function handleGroupCallback(
  query: TgCallbackQuery,
  chatId: number,
  messageId: number | undefined,
): Promise<void> {
  const parts = (query.data ?? "").split(":");
  if (parts[0] !== "gl") {
    // a DM-flow button that somehow surfaced in a group: acknowledge, do nothing
    await answerCallback(query.id);
    return;
  }

  const worker = await findWorker(query.from.id);
  if (!worker || worker.status !== "active") {
    await answerCallback(query.id, GROUP_NOT_A_WORKER);
    return;
  }

  const projectId = Number(parts[1]);
  const project = Number.isFinite(projectId) ? await getProject(projectId) : null;
  if (!project) {
    await answerCallback(query.id, "That project no longer exists.");
    return;
  }
  await answerCallback(query.id);

  const { error } = await supabase.from("group_links").upsert(
    {
      chat_id: chatId,
      project_id: project.id,
      chat_title: query.message?.chat?.title ?? null,
      linked_by: worker.id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "chat_id" },
  );
  if (error) throw error;

  const line = `✅ This group now files to ${project.code} — ${project.name}`;
  if (messageId) await resolvePrompt(chatId, messageId, line);
  else await send(chatId, line);
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
      await send(chatId, HELP_TEXT, { reply_markup: MAIN_KEYBOARD });
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
        { reply_markup: MAIN_KEYBOARD },
      );
      return;
    }
    case "send":
      return cmdSend(chatId, session);
    case "status":
      return cmdStatus(chatId, worker, session);
    case "checkin":
      return cmdCheckin(chatId, worker, session);
    case "checkout":
      return cmdCheckout(chatId, worker, session);
    case "timesheet":
      return cmdTimesheet(chatId, session);
    default:
      await send(chatId, "I don't know that command. Send /help to see what I can do.");
  }
}

/**
 * "Send records" opens a record of any shape: photos, videos, files — or plain
 * text on its own. Forcing an image on someone whose whole update is "no
 * leakages, all good" just loses that update.
 */
async function cmdSend(chatId: number, session: Session): Promise<void> {
  await saveSession(session, { state: "awaiting_record", draft: resetDraft(session.draft) });
  await send(
    chatId,
    `📷 Attach photos, videos or files (📎 below) — or just type what happened.\n` +
      `I'll ask which site it's for.`,
    { reply_markup: MAIN_KEYBOARD },
  );
}

/** A typed update with no media is a full record in its own right. */
async function startTextRecord(
  chatId: number,
  worker: Worker,
  session: Session,
  text: string,
): Promise<void> {
  // "Send records" then a pasted crew list is a timesheet, not a note about one.
  if (looksLikeTimesheet(text)) return startTimesheet(chatId, session, text);

  const rows = await projectKeyboard(worker.id, "pjm");
  if (!rows) {
    await send(chatId, "No active projects yet. Ask your admin to set one up.");
    return;
  }
  await saveSession(session, {
    state: "choosing_project_for_media",
    draft: { ...resetDraft(session.draft), pending_note: text.slice(0, 2000) },
  });
  await send(chatId, "📁 Which site is this for?", {
    reply_markup: { inline_keyboard: rows },
  });
}

async function cmdStatus(chatId: number, worker: Worker, _session: Session): Promise<void> {
  const open = await openAttendance(worker.id);
  await send(
    chatId,
    open
      ? `🕘 Checked in since ${await fmtTime(open.check_in_at)}`
      : "🕘 Not checked in",
    { reply_markup: MAIN_KEYBOARD },
  );
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
  await send(chatId, "Use /checkin or /checkout first.", { reply_markup: MAIN_KEYBOARD });
}

/** Registered site within 1.5 km of a point, nearest first. */
async function nearestSite(lat: number, lng: number): Promise<Project | null> {
  const { data, error } = await supabase
    .from("projects")
    .select("id, code, name, site_lat, site_lng")
    .eq("status", "active")
    .not("site_lat", "is", null);
  if (error || !data) return null;

  let best: Project | null = null;
  let bestMetres = 1500;
  for (const p of data as (Project & { site_lat: number; site_lng: number })[]) {
    const m = haversineMeters(lat, lng, p.site_lat, p.site_lng);
    if (m < bestMetres) {
      bestMetres = m;
      best = { id: p.id, code: p.code, name: p.name };
    }
  }
  return best;
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
      { reply_markup: MAIN_KEYBOARD },
    );
    return;
  }

  // The GPS names the site for THIS attendance row only. It deliberately does
  // not touch where photos file: a worker may shoot a delivery, a supplier yard
  // or another crew's defect from anywhere, so the filing site stays their own
  // explicit choice (📁 Switch site) at all times.
  const nearest = await nearestSite(location.latitude, location.longitude);

  const { data, error } = await supabase
    .from("attendance")
    .insert({
      worker_id: worker.id,
      project_id: nearest?.id ?? null,
      in_lat: location.latitude,
      in_lng: location.longitude,
    })
    .select("id, check_in_at")
    .single();
  if (error) throw error;

  await saveSession(session, { state: "idle" });

  // Attendance only. Where photos file is a separate, worker-chosen setting and
  // is deliberately not mentioned here — conflating the two is what made people
  // think they had to check in before they could send anything.
  const lines = [`✅ Checked in · ${await fmtTime(data.check_in_at)}`];
  if (nearest) lines.push(`📍 ${nearest.code} — ${nearest.name}`);
  await send(chatId, lines.join("\n"), { reply_markup: MAIN_KEYBOARD });
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
    await send(chatId, "You're not checked in. Use /checkin.", { reply_markup: MAIN_KEYBOARD });
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
    reply_markup: MAIN_KEYBOARD,
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

const RESEND_WARNING =
  "⚠️ That file couldn't be saved — resend it? Videos over 20 MB are too big for me; send a smaller clip or photos.";

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

  // Still answering "what's this about?" for the last batch → these files are
  // part of the same batch. Workers send photos one at a time constantly; a new
  // report (and a second prompt) per photo is how you train them to ignore the
  // prompt entirely.
  if (session.state === "adding_note" && session.draft.report_id) {
    const open = await ownedReport(session.draft.report_id, worker.id);
    if (open) {
      const ok = await storeMedia(open, media);
      if (!ok) await send(chatId, RESEND_WARNING);
      if (caption && open.note === null) {
        await supabase.from("reports").update({ note: caption }).eq("id", open.id);
        await saveSession(session, { state: "idle", draft: resetDraft(session.draft) });
      }
      return;
    }
  }

  // No sticky site, no default, no GPS inference: every new batch asks which
  // site it belongs to. One question per batch is the price of never filing a
  // photo to the wrong project — the worker decided that trade-off explicitly.
  // Persist pending media as table rows — concurrent album parts INSERT instead
  // of racing over one session-draft blob.
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
    await send(chatId, "📁 Which site is this for?", {
      reply_markup: { inline_keyboard: rows },
    });
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
  // hand back the finished card so they can still fix the date or site
  await send(chatId, "✅ Description saved.", {
    reply_markup: { inline_keyboard: reportButtons(reportId) },
  });
}

/** "Skip" on the details prompt: close it out, leave the note null. */
async function cbSkipDetails(
  chatId: number,
  messageId: number | undefined,
  session: Session,
  reportId: number,
): Promise<void> {
  await saveSession(session, { state: "idle", draft: resetDraft(session.draft) });
  if (messageId) {
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: "✅ Saved without a description.",
      reply_markup: { inline_keyboard: reportButtons(reportId) },
    });
  } else {
    await send(chatId, "✅ Saved without a description.", {
      reply_markup: { inline_keyboard: reportButtons(reportId) },
    });
  }
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

// ---------------------------------------------------------------- timesheets

const TIMESHEET_PROMPT = [
  "Send the day's list — one line per worker.",
  "",
  "12/08 Team 3 Jurong",
  "101 - 8",
  "102 - 8.5",
  "103 - MC",
  "",
  "I'll show you what I read before anything is saved.",
].join("\n");

const TIMESHEET_GONE = "That timesheet is no longer open. Send the list again.";

async function cmdTimesheet(chatId: number, session: Session): Promise<void> {
  await saveSession(session, { state: "awaiting_timesheet" });
  await send(chatId, TIMESHEET_PROMPT, { reply_markup: MAIN_KEYBOARD });
}

function timesheetButtons(): InlineButton[][] {
  return [
    [{ text: "✅ Save", callback_data: "ts:save" }],
    [
      { text: "📅 Change date", callback_data: "ts:date" },
      { text: "👥 Change team", callback_data: "ts:team" },
    ],
    [
      { text: "📍 Change location", callback_data: "ts:loc" },
      { text: "✖️ Discard", callback_data: "ts:x" },
    ],
  ];
}

/** Telegram HTML mode: escape anything that came from a worker's message. */
function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function entryCell(entry: ParsedTimesheet["entries"][number]): string {
  const value = entry.hours !== null ? `${entry.hours}h` : entry.absenceReason ?? "?";
  const role = entry.role === "worker" ? "" : ` (${entry.role})`;
  return `${entry.workerCode.padEnd(6)}${value}${role}`;
}

async function timesheetCard(sheet: ParsedTimesheet): Promise<string> {
  const assumed = sheet.workDate === null;
  const workDate = sheet.workDate ?? await localDate();

  const head = [`📋 Timesheet — ${await fmtDate(workDate)}${assumed ? " (assumed today)" : ""}`];
  head.push(sheet.teamNumber ? `Team ${sheet.teamNumber}` : "no team");
  if (sheet.location) head.push(sheet.location);

  const hours = sheet.entries.reduce((sum, e) => sum + (e.hours ?? 0), 0);
  const absent = sheet.entries.filter((e) => e.absenceReason !== null).length;

  const lines = [
    esc(head.join(" · ")),
    esc(`${sheet.entries.length} workers · ${Math.round(hours * 10) / 10} h · ${absent} absent`),
  ];

  // the roster itself goes in a <pre> block: Telegram renders it monospaced, so
  // the code/hours columns line up instead of drifting in a proportional font
  const rows: string[] = [];
  for (let i = 0; i < sheet.entries.length; i += 2) {
    const left = entryCell(sheet.entries[i]);
    const right = sheet.entries[i + 1] ? entryCell(sheet.entries[i + 1]) : "";
    rows.push(right ? `${left.padEnd(18)}${right}` : left);
  }
  lines.push(`<pre>${esc(rows.join("\n"))}</pre>`);

  if (sheet.unparsed.length > 0) {
    lines.push(
      "⚠️ Couldn't read:",
      `<pre>${esc(sheet.unparsed.join("\n"))}</pre>`,
    );
  }
  return lines.join("\n");
}

async function sendTimesheetCard(chatId: number, sheet: ParsedTimesheet): Promise<void> {
  await send(chatId, await timesheetCard(sheet), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: timesheetButtons() },
  });
}

async function startTimesheet(chatId: number, session: Session, text: string): Promise<void> {
  const sheet = parseTimesheet(text, await localDate(), await tz());

  if (sheet.entries.length === 0) {
    await saveSession(session, { state: "idle", draft: resetDraft(session.draft) });
    await send(chatId, "I couldn't find any worker lines in that.\n\n" + TIMESHEET_PROMPT);
    return;
  }

  await saveSession(session, {
    state: "idle",
    draft: { ...session.draft, timesheet: sheet, timesheet_raw: text.slice(0, 4000) },
  });
  await sendTimesheetCard(chatId, sheet);
}

/** Apply an edit to the draft and re-send the confirm card. */
async function tsPatch(
  chatId: number,
  session: Session,
  patch: Partial<ParsedTimesheet>,
): Promise<void> {
  const sheet = session.draft.timesheet;
  if (!sheet) {
    await saveSession(session, { state: "idle", draft: resetDraft(session.draft) });
    await send(chatId, TIMESHEET_GONE);
    return;
  }
  const next = { ...sheet, ...patch };
  await saveSession(session, {
    state: "idle",
    draft: { ...session.draft, timesheet: next },
  });
  await sendTimesheetCard(chatId, next);
}

async function tsTypedDate(chatId: number, session: Session, text: string): Promise<void> {
  const parsed = parseDate(text);
  if (!parsed) {
    await send(chatId, "I couldn't read that date. Use 2026-08-03 or 03/08/2026.");
    return;
  }
  await tsPatch(chatId, session, { workDate: parsed });
}

function tsTypedTeam(chatId: number, session: Session, text: string): Promise<void> {
  const team = text.trim().replace(/^team\s*/i, "").slice(0, 20).trim();
  return tsPatch(chatId, session, { teamNumber: team || null });
}

function tsTypedLocation(chatId: number, session: Session, text: string): Promise<void> {
  const location = text.trim().slice(0, 80);
  return tsPatch(chatId, session, { location: location || null });
}

/** Same (work_date, team_number) already filed — team_number is nullable. */
async function findExistingTimesheet(
  workDate: string,
  teamNumber: string | null,
): Promise<{ id: number } | null> {
  let query = supabase.from("timesheets").select("id").eq("work_date", workDate);
  query = teamNumber === null
    ? query.is("team_number", null)
    : query.eq("team_number", teamNumber);
  const { data, error } = await query.order("id").limit(1);
  if (error) throw error;
  return (data?.[0] as { id: number }) ?? null;
}

type SaveMode = "new" | "replace" | "add";

async function tsSave(
  chatId: number,
  worker: Worker,
  session: Session,
  mode: SaveMode,
): Promise<void> {
  const sheet = session.draft.timesheet;
  if (!sheet) {
    await send(chatId, TIMESHEET_GONE);
    return;
  }

  const workDate = sheet.workDate ?? await localDate();

  if (mode !== "add") {
    const existing = await findExistingTimesheet(workDate, sheet.teamNumber);
    if (existing && mode === "new") {
      await send(
        chatId,
        `A timesheet for ${await fmtDate(workDate)} · Team ${sheet.teamNumber ?? "—"} already exists.`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: "♻️ Replace", callback_data: "ts:repl" },
              { text: "➕ Add anyway", callback_data: "ts:add" },
            ]],
          },
        },
      );
      return;
    }
    if (existing && mode === "replace") {
      // entries cascade with the parent row
      const { error } = await supabase.from("timesheets").delete().eq("id", existing.id);
      if (error) throw error;
    }
  }

  const projectId = session.draft.project_id ?? worker.default_project_id ?? null;
  const { data, error } = await supabase
    .from("timesheets")
    .insert({
      work_date: workDate,
      team_number: sheet.teamNumber,
      location: sheet.location,
      project_id: projectId,
      submitted_by: worker.id,
      raw_text: session.draft.timesheet_raw ?? null,
    })
    .select("id")
    .single();
  if (error) throw error;

  // worker_code -> worker_id is resolved by a database trigger
  const rows = sheet.entries.map((e) => ({
    timesheet_id: data.id,
    worker_code: e.workerCode,
    hours: e.hours,
    absence_reason: e.absenceReason,
    role: e.role,
  }));
  const entriesInsert = await supabase.from("timesheet_entries").insert(rows);
  if (entriesInsert.error) {
    // never leave a headerless timesheet behind
    await supabase.from("timesheets").delete().eq("id", data.id);
    throw entriesInsert.error;
  }

  await saveSession(session, { state: "idle", draft: resetDraft(session.draft) });
  await send(
    chatId,
    `✅ Timesheet saved · ${await fmtDate(workDate)} · Team ${sheet.teamNumber ?? "—"} · ${rows.length} entries`,
  );
}

async function handleTimesheetCallback(
  sub: string,
  chatId: number,
  messageId: number | undefined,
  worker: Worker,
  session: Session,
): Promise<void> {
  if (!session.draft.timesheet) {
    await send(chatId, TIMESHEET_GONE);
    return;
  }

  switch (sub) {
    case "save":
      return tsSave(chatId, worker, session, "new");
    case "repl":
      if (messageId) await editKeyboard(chatId, messageId, []);
      return tsSave(chatId, worker, session, "replace");
    case "add":
      if (messageId) await editKeyboard(chatId, messageId, []);
      return tsSave(chatId, worker, session, "add");
    case "date": {
      const rows: InlineButton[][] = [
        [
          { text: "Today", callback_data: "ts:d0" },
          { text: "Yesterday", callback_data: "ts:d1" },
        ],
        [{ text: "✍️ Type date", callback_data: "ts:dt" }],
      ];
      if (messageId) await editKeyboard(chatId, messageId, rows);
      else await send(chatId, "Which date?", { reply_markup: { inline_keyboard: rows } });
      return;
    }
    case "d0":
    case "d1":
      if (messageId) await editKeyboard(chatId, messageId, []);
      return tsPatch(chatId, session, { workDate: await localDate(sub === "d1" ? 1 : 0) });
    case "dt":
      await saveSession(session, { state: "ts_typing_date" });
      await send(chatId, "Send the date as 2026-08-03 or 03/08/2026.");
      return;
    case "team":
      await saveSession(session, { state: "ts_typing_team" });
      await send(chatId, "Send the team, e.g. 3.");
      return;
    case "loc":
      await saveSession(session, { state: "ts_typing_loc" });
      await send(chatId, "Send the location.");
      return;
    case "x":
      if (messageId) await editKeyboard(chatId, messageId, []);
      await saveSession(session, { state: "idle", draft: resetDraft(session.draft) });
      await send(chatId, "Discarded.");
      return;
    default:
      console.error("unknown timesheet callback", sub);
  }
}

// ---------------------------------------------------------------- callbacks

async function handleCallbackQuery(query: TgCallbackQuery): Promise<void> {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const chat = query.message?.chat;
  if (!chatId || !query.data) {
    await answerCallback(query.id);
    return;
  }
  if (chat && isGroupChat(chat)) return handleGroupCallback(query, chatId, messageId);
  if (chat?.type && chat.type !== "private") {
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
  const reportActions = ["rn", "rd", "rdd", "rdt", "rp", "rpp", "nskip"];
  if (reportActions.includes(action)) {
    const report = await ownedReport(Number(parts[1]), worker.id);
    if (!report) {
      await send(chatId, NOT_YOURS);
      return;
    }
  }

  switch (action) {
    case "nskip":
      return cbSkipDetails(chatId, messageId, session, Number(parts[1]));
    case "ts":
      return handleTimesheetCallback(parts[1] ?? "", chatId, messageId, worker, session);
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

  // Text-only record: no files, the description IS the report. Attribution is
  // the report row itself — worker_id is set on insert, same as media reports.
  if (pending.length === 0 && session.draft.pending_note) {
    const note = session.draft.pending_note; // saveSession mutates the draft
    const { report } = await createReport(worker.id, projectId, note);
    await saveSession(session, { state: "idle", draft: { report_id: report.id } });
    const line = `✅ Noted → ${project.code} · ${await fmtDate(report.report_date)}\n“${note.slice(0, 120)}”`;
    if (messageId) await resolvePrompt(chatId, messageId, line);
    else await send(chatId, line, { reply_markup: MAIN_KEYBOARD });
    return;
  }

  if (pending.length === 0) {
    // stale tap — the batch was already saved or cancelled
    await saveSession(session, { state: "idle", draft: resetDraft(session.draft) });
    const line = "No files waiting — send them again and I'll ask for the site.";
    if (messageId) await resolvePrompt(chatId, messageId, line);
    else await send(chatId, line);
    return;
  }

  if (messageId) {
    await resolvePrompt(chatId, messageId, `📁 Filing to ${project.code} — ${project.name}`);
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
    draft: { report_id: report.id },
  });

  if (stored === 0) {
    if (created) await supabase.from("reports").delete().eq("id", report.id);
    await send(chatId, "⚠️ None of the files could be saved — please resend them.");
    return;
  }
  if (created) {
    if (report.note !== null) await sendReportConfirmation(chatId, report, project.code);
    else await askForDetails(chatId, session, report, project.code, stored);
  }
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

/**
 * Refresh the saved-report card in place. Editing the card beats sending another
 * "✅ Date set to…" line each time — after three tweaks the chat is all receipts
 * and the worker can no longer see what the report actually says.
 */
async function refreshReportCard(
  chatId: number,
  messageId: number | undefined,
  reportId: number,
): Promise<void> {
  if (!messageId) return;
  const { data, error } = await supabase
    .from("reports")
    .select("id, report_date, projects(code)")
    .eq("id", reportId)
    .maybeSingle();
  if (error || !data) return;

  const code = (data as { projects?: { code?: string } | null }).projects?.code ?? "site";
  await tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: `✅ Saved → ${code} · ${await fmtDate(data.report_date as string)}`,
    reply_markup: { inline_keyboard: reportButtons(reportId) },
  });
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
  if (messageId) await refreshReportCard(chatId, messageId, reportId);
  else await send(chatId, `✅ Date set to ${await fmtDate(date)}.`);
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
  if (messageId) await refreshReportCard(chatId, messageId, reportId);
  else await send(chatId, `✅ Moved to ${project.code} — ${project.name}.`);
}

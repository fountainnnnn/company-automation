// Telegram bot webhook — construction-site reporting.
//
// Stateless: every update re-resolves the worker and the chat session from the
// database. Secrets and settings are cached in module scope for the lifetime of
// the isolate. Always answers 200 for authenticated updates so Telegram never
// enters a retry storm because of an internal failure.

import { AsyncLocalStorage } from "node:async_hooks";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * Per-request send queue. A round trip to api.telegram.org costs ~900ms from
 * this runtime, but Telegram will execute ONE method passed back as the
 * webhook's own HTTP response — free and instant. So sends are queued during
 * handling; at the end the last one rides the response and the rest (rare)
 * go out via the API first, preserving order. Request-scoped via
 * AsyncLocalStorage so concurrent updates in one isolate can never cross wires.
 */
interface ReqCtx {
  queue: { method: string; payload: Record<string, unknown> }[];
  bg: Promise<unknown>[];
  /** Session writes are chained, never raced — see saveSessionSoon. */
  sessionWrite: Promise<unknown>;
}
const reqCtx = new AsyncLocalStorage<ReqCtx>();

// ---- latency tracing (surfaced only on x-debug requests) -------------------
const trace = { db: 0, dbn: 0, tg: 0, tgn: 0, other: 0, othern: 0 };
function traceReset() {
  trace.db = trace.dbn = trace.tg = trace.tgn = trace.other = trace.othern = 0;
}
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const t0 = performance.now();
    try {
      return await realFetch(input, init);
    } finally {
      const dt = performance.now() - t0;
      if (url.includes("supabase.co")) {
        trace.db += dt;
        trace.dbn++;
      } else if (url.includes("telegram.org")) {
        trace.tg += dt;
        trace.tgn++;
      } else {
        trace.other += dt;
        trace.othern++;
      }
    }
  };
}

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
  /** Newline-joined mirror of report_notes, maintained by a database trigger. */
  note: string | null;
  /** Human-facing record id, `CL-YYYYMMDD-NNN`, assigned by a database trigger. */
  job_ref: string;
  /** `open` while the worker is still adding to it; `final` once they're done. */
  status: "open" | "final";
  /** Only present on the row bot_context hands back (full row as jsonb). */
  created_at?: string;
  updated_at?: string;
}

/** Columns every report read asks for. */
const REPORT_COLS = "id, project_id, worker_id, report_date, note, job_ref, status";

/** One timestamped line of a record's description. Never concatenated. */
interface ReportNote {
  body: string;
  created_at: string;
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
  /** The open record's card, so every addition edits it instead of stacking a new one. */
  card_message_id?: number;
  /**
   * The card is currently showing the review step. Edits reached from there
   * (note, date, site) return to the review rather than the open card — the
   * worker was on their way out, so don't drop them back a step.
   */
  review?: boolean;
  /** The note being rewritten, while the state is `editing_note`. */
  note_id?: number;
  pending_group?: string | null;
  /** Text-only record waiting for its site pick. */
  pending_note?: string;
}

type SessionState =
  | "idle"
  | "choosing_project_for_media"
  | "adding_note"
  | "editing_note"
  | "typing_date"
  | "awaiting_record";

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
  const res = await supabase.from("settings").select("key, value").eq("key", "timezone");
  if (res.error) {
    // fall back to the stale value rather than failing the update
    if (settingsCache) return settingsCache.value;
    throw res.error;
  }
  const map = Object.fromEntries(
    (res.data ?? []).map((r) => [r.key as string, r.value]),
  );
  return cacheSettings(map)!;
}

/**
 * Fill the settings cache from a `{key: value}` blob — the shape both the
 * settings table and bot_context hand back. Returns null when there is nothing
 * to cache, so the hot path can fall through to a real read.
 */
function cacheSettings(map: Record<string, unknown> | null | undefined): Settings | null {
  if (!map) return null;
  const tz = map["timezone"];
  const value: Settings = {
    timezone: typeof tz === "string" && tz ? tz : "Asia/Singapore",
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
  const payload = { chat_id: chatId, text, ...extra };
  const ctx = reqCtx.getStore();
  if (ctx) {
    ctx.queue.push({ method: "sendMessage", payload });
    return Promise.resolve(null);
  }
  return tg("sendMessage", payload);
}

/**
 * Rewrite a message in place. Queued like `send`, so the last one rides the
 * webhook response for free. Use `tg("editMessageText", …)` directly instead
 * when the caller has to know whether Telegram accepted the edit.
 */
function edit(
  chatId: number,
  messageId: number,
  text: string,
  extra: Record<string, unknown> = {},
) {
  const payload = { chat_id: chatId, message_id: messageId, text, ...extra };
  const ctx = reqCtx.getStore();
  if (ctx) {
    ctx.queue.push({ method: "editMessageText", payload });
    return Promise.resolve(null);
  }
  return tg("editMessageText", payload);
}

/**
 * Work that the reply doesn't depend on. Still awaited before the response is
 * returned — this overlaps it with the reply instead of blocking on it — but a
 * failure can never take the update down with it.
 */
function background(work: Promise<unknown>): void {
  const guarded = work.catch((err) => console.error("background task failed", err));
  const ctx = reqCtx.getStore();
  if (ctx) ctx.bg.push(guarded);
}

function answerCallback(id: string, text?: string) {
  const payload = text ? { callback_query_id: id, text } : { callback_query_id: id };
  const ctx = reqCtx.getStore();
  if (ctx) {
    // fire now, in parallel with the handler — the spinner stops sooner and
    // the round trip overlaps the DB work instead of preceding it
    const p = tg("answerCallbackQuery", payload);
    ctx.bg.push(p);
    return Promise.resolve(null);
  }
  return tg("answerCallbackQuery", payload);
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
function resolvePrompt(
  chatId: number,
  messageId: number,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: { inline_keyboard: [] },
    ...extra,
  });
}

/**
 * Acknowledge without speaking. In a crew group a "✅ saved" line per photo is
 * noise that buries the crew's own conversation, so the receipt is a reaction on
 * their message. `tg` already swallows failures — a missing reaction is silent.
 */
function react(chatId: number, messageId: number, emoji: string) {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: "emoji", emoji }],
  };
  const ctx = reqCtx.getStore();
  if (ctx) {
    // acknowledgement, not conversation — overlap it with the handler
    const p = tg("setMessageReaction", payload);
    ctx.bg.push(p);
    return Promise.resolve(null);
  }
  return tg("setMessageReaction", payload);
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

/**
 * The escape hatch every prompt carries. /cancel existed all along but nothing
 * on screen ever said so, which made a mistyped flow feel like a dead end.
 */
const CANCEL_MARKUP = { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "cx" }]] };

/** The site picker's own cancel — it has files parked in pending_media to drop. */
function withMediaCancel(rows: InlineButton[][]): InlineButton[][] {
  return [...rows, [{ text: "❌ Cancel", callback_data: "cxm" }]];
}


/**
 * The standing button bar. Workers on site should never have to remember a
 * slash command — every action is one tap, and the bar stays put between
 * messages (is_persistent) so the chat never dead-ends.
 */
const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: "📷 Send records" }],
    // "My day" is the worker's own read-only view — the half that makes this
    // feel like an application rather than a drop box
    [{ text: "📄 My day" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

/**
 * Labels from features that no longer exist. A reply keyboard lives in the
 * worker's Telegram until the bot replaces it, so these keep arriving for a
 * while after the buttons are gone — and a tapped ghost must never be mistaken
 * for a description and filed onto an open record.
 */
const RETIRED_BUTTONS = new Set([
  "checkin",
  "checkout",
  "status",
  "timesheet",
]);

/** Map a tapped button back to the command it stands for. */
function buttonCommand(text: string): string | null {
  const key = text.replace(/[^a-z]/gi, "").toLowerCase();
  const map: Record<string, string> = {
    sendrecords: "send",
    myday: "today",
    cancel: "cancel",
    // /help stays a command even though the button gave up its slot
    help: "help",
  };
  if (map[key]) return map[key];
  return RETIRED_BUTTONS.has(key) ? "retired" : null;
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

/** "4 Aug 2026" — cards carry the year, one-liners don't. */
async function fmtDateFull(isoDate: string): Promise<string> {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: await tz(),
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
}

/** The calendar date an instant falls on, in the configured timezone. */
async function localDateOf(when: Date | string): Promise<string> {
  const d = typeof when === "string" ? new Date(when) : when;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: await tz(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Today (or today minus `daysBack`) as YYYY-MM-DD in the configured timezone. */
function localDate(daysBack = 0): Promise<string> {
  return localDateOf(new Date(Date.now() - daysBack * 86_400_000));
}

// ---------------------------------------------------------------- session

/** A non-idle state left alone this long is stale — revert to idle, keep the sticky project. */
const SESSION_STALE_MS = 30 * 60_000;

/** A chat_sessions row (or nothing) as the in-memory session. */
function sessionFromRow(
  chatId: number,
  row: { worker_id?: number | null; state?: string | null; draft?: Draft | null; updated_at?: string }
    | null
    | undefined,
): Session {
  if (!row) return { chat_id: chatId, worker_id: null, state: "idle", draft: {} };

  let state = (row.state ?? "idle") as SessionState;
  let draft = (row.draft ?? {}) as Draft;
  const age = Date.now() - new Date(row.updated_at ?? 0).getTime();
  if (state !== "idle" && age > SESSION_STALE_MS) {
    state = "idle";
    draft = resetDraft(draft);
  }

  return {
    chat_id: chatId,
    worker_id: row.worker_id ?? null,
    state,
    draft,
  };
}

/**
 * Apply the patch in memory and persist it alongside the reply rather than
 * before it. The caller's object is mutated synchronously, so anything later in
 * the same update reads the new value; the write itself is chained behind any
 * earlier one (two upserts on one row must not race) and awaited before the
 * response goes back, so the next update always sees it.
 */
function saveSessionSoon(session: Session, patch: Partial<Session>): void {
  if (patch.worker_id !== undefined) session.worker_id = patch.worker_id;
  if (patch.state !== undefined) session.state = patch.state;
  if (patch.draft !== undefined) session.draft = patch.draft;

  const row = {
    chat_id: session.chat_id,
    worker_id: session.worker_id,
    state: session.state,
    draft: session.draft,
    updated_at: new Date().toISOString(),
  };
  const write = () => persistSession(row);

  const ctx = reqCtx.getStore();
  if (!ctx) {
    background(write());
    return;
  }
  ctx.sessionWrite = ctx.sessionWrite.then(write).catch((err) =>
    console.error("session write failed", err)
  );
  ctx.bg.push(ctx.sessionWrite);
}

async function persistSession(row: Record<string, unknown>): Promise<void> {
  const { error } = await supabase
    .from("chat_sessions")
    .upsert(row, { onConflict: "chat_id" });
  if (error) throw error;
}

/** Clear transient draft keys, keeping the sticky project. */
function resetDraft(_draft: Draft): Draft {
  return {};
}

/**
 * Cancelling a PROMPT is not discarding the record. Drop whatever the question
 * was holding, but keep an open record's card link so the next photo still
 * edits that card instead of opening a second one.
 */
function cancelDraft(draft: Draft, openReport: Report | null): Draft {
  if (!openReport) return resetDraft(draft);
  const kept: Draft = { report_id: openReport.id, card_message_id: draft.card_message_id };
  if (draft.review) kept.review = true;
  return kept;
}

// ---------------------------------------------------------------- data access

/**
 * Everything an update needs to know before it can do anything: who sent it,
 * what they were in the middle of, what the chat is bound to, and whether they
 * have a record still open. One round trip instead of four — with 30-40 workers
 * posting at once the serial lookups were most of the warm latency.
 */
interface BotContext {
  worker: Worker | null;
  session: Session;
  groupLink: GroupLink | null;
  openReport: Report | null;
  projects: Project[];
}

async function loadBotContext(
  chatId: number,
  telegramUserId: number,
  username?: string | null,
): Promise<BotContext> {
  const { data, error } = await supabase.rpc("bot_context", {
    p_chat_id: chatId,
    p_tg_user_id: telegramUserId,
    p_username: username ?? null,
  });
  if (error) throw error;

  const ctx = (data ?? {}) as {
    worker?: Worker | null;
    session?: Parameters<typeof sessionFromRow>[1];
    group_link?: GroupLink | null;
    settings?: Record<string, unknown> | null;
    open_report?: Report | null;
    projects?: Project[] | null;
  };
  // the settings cache rides along, so getSettings() almost never reads
  cacheSettings(ctx.settings);
  cacheProjects(ctx.worker?.id, ctx.projects);

  return {
    worker: ctx.worker ?? null,
    session: sessionFromRow(chatId, ctx.session),
    groupLink: ctx.group_link ?? null,
    openReport: ctx.open_report ?? null,
    projects: ctx.projects ?? [],
  };
}

/**
 * bot_context already returns the worker's sites on every message, so prime the
 * cache with them. listProjects then answers from memory instead of spending a
 * round trip to draw a picker — the pick path was the slowest thing a worker
 * touched, and it was re-reading a list we had just fetched.
 */
const PROJECTS_TTL_MS = 5 * 60_000;
const projectCache = new Map<number, { at: number; rows: Project[] }>();

function cacheProjects(workerId: number | undefined, rows: Project[] | null | undefined): void {
  if (!workerId || !rows) return;
  projectCache.set(workerId, { at: Date.now(), rows });
}

function cachedProjects(workerId: number): Project[] | null {
  const hit = projectCache.get(workerId);
  if (hit && Date.now() - hit.at < PROJECTS_TTL_MS) return hit.rows;
  if (hit) projectCache.delete(workerId);
  return null;
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
  const warm = cachedProjects(workerId);
  if (warm) return warm;

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
    const sorted = mine.sort((a, b) => a.code.localeCompare(b.code));
    cacheProjects(workerId, sorted);
    return sorted;
  }

  const all = await supabase
    .from("projects")
    .select("id, code, name")
    .eq("status", "active")
    .order("code");
  if (all.error) throw all.error;
  const rows = (all.data ?? []) as Project[];
  cacheProjects(workerId, rows);
  return rows;
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

// ---------------------------------------------------------------- presentation
//
// A chat is a terrible place to read a form, so anything with more than one
// fact in it is rendered as a card: a bold title, then a <pre> block whose
// monospace font is the only way to get key/value rows to line up on a phone.
// Everything interpolated goes through esc() — a worker's description is
// attacker-controlled text and must never be able to close a tag.

/** Telegram HTML mode: escape anything that came from a worker's message. */
function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Widest label the card grid allows; wider wraps on a narrow phone. */
const CARD_LABEL_WIDTH = 13;

/**
 * Bold title, a <pre> grid of label/value rows, an optional footer beneath it.
 * Every message that states more than one fact is built from this.
 */
function card(title: string, rows: [string, string][], footer?: string): string {
  const grid = rows
    .map(([label, value]) => `${esc(label.padEnd(CARD_LABEL_WIDTH))}${esc(oneLine(value))}`)
    .join("\n");
  const out = [`<b>${esc(title)}</b>`, `<pre>${grid}</pre>`];
  if (footer) out.push(esc(footer));
  return out.join("\n");
}

/** Collapse to a single line and cap it — a card row must not wrap or split. */
function oneLine(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function ordinal(n: number): string {
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  const last = n % 10;
  return `${n}${last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th"}`;
}

/** "3 photos" / "1 video" / "2 files" — mixed kinds collapse to "files". */
function mediaLabel(types: string[]): string {
  const n = types.length;
  if (n === 0) return "none";
  const plural = n === 1 ? "" : "s";
  const kinds = new Set(types);
  if (kinds.size === 1) {
    if (types[0] === "photo") return `${n} photo${plural}`;
    if (types[0] === "video") return `${n} video${plural}`;
  }
  return `${n} file${plural}`;
}

// ---------------------------------------------------------------- messages

// Three independent jobs. Workers kept assuming one had to precede another, so
// the help says outright that they don't.
const HELP_TEXT = [
  "📷 SITE RECORDS",
  "Send photos, videos, files — or just type what happened.",
  "I'll ask which site it's for. A caption becomes the note.",
  "The record stays open: keep adding, then tap ✅ Done.",
  "",
  "📄 MY DAY",
  "Every record you've filed today. Read-only.",
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

/** The buttons an open record carries until the worker says it's finished. */
function openReportButtons(reportId: number): InlineButton[][] {
  return [
    [{ text: "✅ Done", callback_data: `nfin:${reportId}` }],
    [
      { text: "📝 Add note", callback_data: `rn:${reportId}` },
      { text: "📅 Set date", callback_data: `rd:${reportId}` },
    ],
    [{ text: "📁 Change site", callback_data: `rp:${reportId}` }],
  ];
}

/**
 * The last stop before a record is saved. ✅ Done used to BE the save, so a
 * worker who tapped it to see where they were had already committed; now it
 * shows what is about to be filed and nothing is final until they say so again.
 */
function reviewButtons(
  reportId: number,
  mediaTypes: string[],
  noteCount: number,
): InlineButton[][] {
  const rows: InlineButton[][] = [
    [{ text: "✅ Confirm & save", callback_data: `rvok:${reportId}` }],
  ];
  if (mediaTypes.length > 0) {
    const photos = mediaTypes.some((t) => t === "photo");
    rows.push([{
      text: photos ? "🖼 Preview photos" : "🖼 Preview files",
      callback_data: `rvpv:${reportId}`,
    }]);
  }
  const noteRow: InlineButton[] = [{ text: "📝 Add note", callback_data: `rn:${reportId}` }];
  if (noteCount > 0) noteRow.push({ text: "✏️ Edit notes", callback_data: `rvn:${reportId}` });
  rows.push(noteRow);
  rows.push([
    { text: "📅 Date", callback_data: `rd:${reportId}` },
    { text: "📁 Site", callback_data: `rp:${reportId}` },
  ]);
  rows.push([
    { text: "↩️ Keep adding", callback_data: `rvbk:${reportId}` },
    { text: "🗑 Discard", callback_data: `rvdel:${reportId}` },
  ]);
  return rows;
}

/** Everything a record card states, gathered in one shape. */
interface RecordCard {
  jobRef: string;
  reportDate: string;
  notes: ReportNote[];
  code: string;
  name: string;
  mediaTypes: string[];
}

function siteLine(c: RecordCard): string {
  return c.name ? `${c.code} — ${c.name}` : c.code;
}

/** Oldest first — a description reads in the order it was dictated. */
function sortNotes(notes: ReportNote[]): ReportNote[] {
  return [...notes].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * The description, as the separate entries it actually is:
 *
 *   Notes
 *   11:22  big stuffs
 *   11:23  big stuffs too
 *
 * Two sentences typed a minute apart are two facts about two moments; running
 * them together as one blob loses which was said when.
 */
async function notesSection(notes: ReportNote[]): Promise<string> {
  if (notes.length === 0) return "";
  const lines: string[] = [];
  for (const n of notes) lines.push(`${await fmtTime(n.created_at)}  ${oneLine(n.body, 48)}`);
  return `\n<b>Notes</b>\n<pre>${esc(lines.join("\n"))}</pre>`;
}

/** One round trip for a record and everything shown alongside it. */
async function loadRecordCard(reportId: number): Promise<RecordCard | null> {
  const { data, error } = await supabase
    .from("reports")
    .select(
      "id, job_ref, report_date, projects(code, name), report_media(media_type), report_notes(body, created_at)",
    )
    .eq("id", reportId)
    .maybeSingle();
  if (error || !data) return null;

  const row = data as {
    job_ref: string | null;
    report_date: string;
    projects?: { code?: string; name?: string } | null;
    report_media?: { media_type: string }[] | null;
    report_notes?: ReportNote[] | null;
  };
  return {
    jobRef: row.job_ref ?? "—",
    reportDate: row.report_date,
    notes: sortNotes(row.report_notes ?? []),
    code: row.projects?.code ?? "site",
    name: row.projects?.name ?? "",
    mediaTypes: (row.report_media ?? []).map((m) => m.media_type),
  };
}

/** How many records this worker has filed today — the receipt's human touch. */
async function recordsToday(workerId: number): Promise<number> {
  const { count, error } = await supabase
    .from("reports")
    .select("id", { count: "exact", head: true })
    .eq("worker_id", workerId)
    .eq("report_date", await localDate());
  if (error) {
    console.error("daily tally failed", error);
    return 0;
  }
  return count ?? 0;
}

/** The end of a record: what was filed, where it went, and how the day is going. */
async function receiptCard(c: RecordCard, tally: number): Promise<string> {
  const rows: [string, string][] = [
    ["Ref", c.jobRef],
    ["Site", siteLine(c)],
    ["Date", await fmtDateFull(c.reportDate)],
  ];
  if (c.notes.length === 0) rows.push(["Description", "—"]);
  if (c.mediaTypes.length > 0) rows.push(["Files", mediaLabel(c.mediaTypes)]);

  const footer = [
    c.name ? `Saved to the ${c.name} archive.` : "Saved to the site archive.",
    tally > 0 ? `That's your ${ordinal(tally)} record today. 💪` : "",
  ].filter(Boolean).join("\n");
  // notes sit between the grid and the footer: they're the record, not a remark
  return `${card("🎉 Record saved", rows)}${await notesSection(c.notes)}\n${esc(footer)}`;
}

const OPEN_RECORD_HINT = "Still open — send more photos or notes, then tap ✅ Done.";

/**
 * A record that hasn't been closed yet. It exists because the old flow sealed a
 * record the moment a description arrived: a worker who sent six photos and then
 * remembered the caption ended up with two half-records. Nothing is final until
 * they say so, and every addition re-renders this same card.
 */
async function openRecordCard(c: RecordCard, worker: Worker): Promise<string> {
  const rows: [string, string][] = [
    ["Ref", c.jobRef],
    ["Site", siteLine(c)],
    ["Date", await fmtDateFull(c.reportDate)],
    ["Filed by", worker.full_name],
  ];
  if (c.mediaTypes.length > 0) rows.push(["Files", mediaLabel(c.mediaTypes)]);

  const summary = [
    c.mediaTypes.length > 0 ? mediaLabel(c.mediaTypes) : "no files yet",
    `${c.notes.length} note${c.notes.length === 1 ? "" : "s"}`,
  ].join(" · ");
  return `${card("📋 Record — still open", rows)}${await notesSection(c.notes)}\n${
    esc(`${summary} so far.`)
  }\n${esc(OPEN_RECORD_HINT)}`;
}

/**
 * What ✅ Done now shows: the record exactly as it will be filed, with nothing
 * written to the database yet. Same facts as the receipt, phrased as a question.
 */
async function reviewCard(c: RecordCard): Promise<string> {
  const rows: [string, string][] = [
    ["Ref", c.jobRef],
    ["Site", siteLine(c)],
    ["Date", await fmtDateFull(c.reportDate)],
  ];
  if (c.mediaTypes.length > 0) rows.push(["Files", mediaLabel(c.mediaTypes)]);
  return `${card("🧾 Ready to save — check it over", rows)}${await notesSection(c.notes)}`;
}

/**
 * The site question, led by what the bot already knows. Seeing date, time and
 * name filled in before the one blank field is what makes a single question
 * feel like the end of a form instead of the start of one.
 */
async function newRecordPrompt(
  title: string,
  worker: Worker,
  mediaTypes: string[] | null,
): Promise<string> {
  const rows: [string, string][] = [
    ["Date", await fmtDateFull(await localDate())],
    ["Time", await fmtTime(new Date())],
    ["Filed by", worker.full_name],
  ];
  if (mediaTypes) rows.push(["Files", mediaLabel(mediaTypes)]);
  return `${card(title, rows)}\n📁 Which site is this for?`;
}

// ---------------------------------------------------------------- open records
//
// A DM record is a conversation, not a form submission: it opens on the first
// thing sent, absorbs everything that follows, and closes only when the worker
// taps ✅ Done. A group record never opens — the crew posts and moves on.

/** An open record left alone this long is finished in all but name. */
const OPEN_RECORD_STALE_MS = 30 * 60_000;

/** Notes are rows now — the reports.note mirror is maintained by a trigger. */
async function addNote(reportId: number, workerId: number, body: string): Promise<void> {
  const text = body.trim();
  if (!text) return;
  const { error } = await supabase.from("report_notes").insert({
    report_id: reportId,
    worker_id: workerId,
    body: text.slice(0, 2000),
  });
  if (error) throw error;
}

/** The record's newest note, for prompts that quote what's already there. */
async function latestNote(reportId: number): Promise<string | null> {
  const { data, error } = await supabase
    .from("report_notes")
    .select("body")
    .eq("report_id", reportId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data?.[0]?.body as string) ?? null;
}

/** How many notes the edit list offers before it stops. */
const NOTE_LIST_LIMIT = 8;

interface NoteRow {
  id: number;
  body: string;
  created_at: string;
}

/** The newest notes on a record, oldest of them first — reading order. */
async function listNotes(reportId: number): Promise<NoteRow[]> {
  const { data, error } = await supabase
    .from("report_notes")
    .select("id, body, created_at")
    .eq("report_id", reportId)
    .order("created_at", { ascending: false })
    .limit(NOTE_LIST_LIMIT);
  if (error) throw error;
  return ((data ?? []) as NoteRow[]).reverse();
}

/**
 * A note, but only if the record it belongs to belongs to this worker. Callback
 * data is attacker-controllable, so the ownership join is the authorization for
 * every note-scoped button — never trust the id that came back.
 */
async function ownedNote(
  noteId: number,
  workerId: number,
): Promise<(NoteRow & { report_id: number }) | null> {
  if (!Number.isFinite(noteId)) return null;
  const { data, error } = await supabase
    .from("report_notes")
    .select("id, body, created_at, report_id, reports!inner(worker_id)")
    .eq("id", noteId)
    .eq("reports.worker_id", workerId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as unknown as NoteRow & { report_id: number };
  return {
    id: row.id,
    body: row.body,
    created_at: row.created_at,
    report_id: row.report_id,
  };
}

/** Finalise — never delete. The files are real work whatever the worker meant. */
async function closeReport(reportId: number, workerId: number): Promise<void> {
  const { error } = await supabase
    .from("reports")
    .update({ status: "final", closed_at: new Date().toISOString() })
    .eq("id", reportId)
    .eq("worker_id", workerId);
  if (error) throw error;
}

/**
 * The record a worker's next photo should join, or null to start a fresh one.
 * A record nobody has touched for half an hour belongs to a job that's over —
 * close it quietly rather than filing tomorrow's wall into yesterday's pour.
 */
function liveOpenReport(report: Report | null): Report | null {
  if (!report) return null;
  const stamps = [report.updated_at, report.created_at]
    .map((t) => Date.parse(t ?? ""))
    .filter((t) => Number.isFinite(t));
  if (stamps.length === 0) return report; // no clock to judge it by — leave it open
  if (Date.now() - Math.max(...stamps) > OPEN_RECORD_STALE_MS) {
    background(closeReport(report.id, report.worker_id));
    return null;
  }
  return report;
}

/**
 * Render the open record and remember which message holds it, so the next photo
 * edits that card instead of stacking another one under it. `messageId` is the
 * card to reuse — the site picker on the way in, the card itself afterwards.
 * `resend` is off for album parts: eight of them land at once and a failed edit
 * would turn into eight fresh cards. `queued` is on when the message being
 * rewritten is the one whose button we're answering — it exists by definition,
 * so the edit can ride the webhook response instead of costing a round trip.
 */
async function showOpenRecord(
  chatId: number,
  messageId: number | undefined,
  worker: Worker,
  session: Session,
  reportId: number,
  { resend = true, queued = false }: { resend?: boolean; queued?: boolean } = {},
): Promise<void> {
  const c = await loadRecordCard(reportId);
  if (!c) return;
  const text = await openRecordCard(c, worker);
  const reply_markup = { inline_keyboard: openReportButtons(reportId) };

  if (queued && messageId !== undefined) {
    await edit(chatId, messageId, text, { parse_mode: "HTML", reply_markup });
    saveSessionSoon(session, {
      state: "idle",
      draft: { report_id: reportId, card_message_id: messageId },
    });
    return;
  }

  let cardId = messageId;
  if (cardId !== undefined) {
    const ok = await tg("editMessageText", {
      chat_id: chatId,
      message_id: cardId,
      text,
      parse_mode: "HTML",
      reply_markup,
    });
    if (!ok) cardId = undefined;
  }
  if (cardId === undefined && (resend || messageId === undefined)) {
    const sent = await tg("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup,
    });
    cardId = (sent?.message_id as number) ?? undefined;
  }

  saveSessionSoon(session, {
    state: "idle",
    draft: { report_id: reportId, card_message_id: cardId },
  });
}

/**
 * Draw a review-step screen over the record's card and remember it, so the
 * review and its sub-panels (the note list, a single note, the discard
 * confirmation) all reuse one message instead of stacking. `review` stays set
 * on the draft so an edit made from here comes back here.
 */
async function showPanel(
  chatId: number,
  messageId: number | undefined,
  session: Session,
  reportId: number,
  text: string,
  rows: InlineButton[][],
  queued: boolean,
): Promise<void> {
  const reply_markup = { inline_keyboard: rows };
  let cardId = messageId;

  if (queued && cardId !== undefined) {
    await edit(chatId, cardId, text, { parse_mode: "HTML", reply_markup });
  } else {
    if (cardId !== undefined) {
      const ok = await tg("editMessageText", {
        chat_id: chatId,
        message_id: cardId,
        text,
        parse_mode: "HTML",
        reply_markup,
      });
      if (!ok) cardId = undefined;
    }
    if (cardId === undefined) {
      const sent = await tg("sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        reply_markup,
      });
      cardId = (sent?.message_id as number) ?? undefined;
    }
  }

  saveSessionSoon(session, {
    state: "idle",
    draft: { report_id: reportId, card_message_id: cardId, review: true },
  });
}

async function showReviewCard(
  chatId: number,
  messageId: number | undefined,
  session: Session,
  reportId: number,
  { queued = false }: { queued?: boolean } = {},
): Promise<void> {
  const c = await loadRecordCard(reportId);
  if (!c) return;
  await showPanel(
    chatId,
    messageId,
    session,
    reportId,
    await reviewCard(c),
    reviewButtons(reportId, c.mediaTypes, c.notes.length),
    queued,
  );
}

/**
 * One worker, one open record. Opening a new one closes whatever was still
 * open, quietly and off the reply path — two open records would mean the next
 * photo had two homes and no rule for choosing.
 */
function closePrevious(previous: Report | null, newId: number, workerId: number): void {
  if (previous && previous.id !== newId) background(closeReport(previous.id, workerId));
}

/** Typed text while a record is open: one more note on it, not a new record. */
async function joinOpenRecord(
  chatId: number,
  worker: Worker,
  session: Session,
  report: Report,
  text: string,
): Promise<void> {
  await addNote(report.id, worker.id, text);
  await showOpenRecord(chatId, session.draft.card_message_id, worker, session, report.id);
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

  const debug = req.headers.get("x-debug") === "1";
  if (debug) traceReset();
  const t0 = performance.now();

  const ctx: ReqCtx = { queue: [], bg: [], sessionWrite: Promise.resolve() };
  let failed: unknown = null;
  try {
    await reqCtx.run(ctx, () => handleUpdate(update));
  } catch (err) {
    failed = err;
    console.error("update handling failed", err);
  }

  // Flush queued sends: everything except the last goes out via the API (in
  // order); the last rides the webhook response itself, which Telegram
  // executes on receipt — the user's reply costs zero extra round trips.
  const last = ctx.queue.length > 0 && !debug ? ctx.queue[ctx.queue.length - 1] : null;
  const viaApi = last ? ctx.queue.slice(0, -1) : ctx.queue;
  for (const q of viaApi) await tg(q.method, q.payload);
  await Promise.all(ctx.bg);

  if (debug) {
    if (failed) {
      const e = failed as { message?: string; code?: string };
      return jsonResponse({ ok: false, error: String(e?.message ?? failed), code: e?.code ?? null });
    }
    return jsonResponse({
      ok: true,
      ms: Math.round(performance.now() - t0),
      db_ms: Math.round(trace.db),
      db_calls: trace.dbn,
      tg_ms: Math.round(trace.tg),
      tg_calls: trace.tgn,
      other_ms: Math.round(trace.other),
    });
  }
  if (last) return jsonResponse({ method: last.method, ...last.payload });
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
  const group = isGroupChat(message.chat);
  // our own posts and other bots are not site records — decided before any read
  if (group && from.is_bot) return;
  // Anything else (channels) has no sender to attribute work to.
  if (!group && message.chat.type && message.chat.type !== "private") return;

  const chatId = message.chat.id;
  // worker + session + group link + settings + open record, in one round trip
  const ctx = await loadBotContext(chatId, from.id, from.username);
  // A group session is shared by everyone in the chat, so group handling never
  // reads it — only the pieces below are passed through.
  if (group) return handleGroupMessage(message, from, ctx.groupLink, ctx.worker);

  const { session, worker } = ctx;
  if (!worker) return handleUnregistered(chatId, session, from);

  if (session.worker_id !== worker.id) {
    saveSessionSoon(session, { worker_id: worker.id });
  }

  if (worker.status === "pending") {
    await send(chatId, "Your account is not active. Contact your admin.");
    return;
  }
  if (worker.status === "disabled") {
    await send(chatId, "Your account is disabled. Contact your admin.");
    return;
  }

  // A record the worker hasn't closed yet swallows everything that follows it.
  const openReport = liveOpenReport(ctx.openReport);

  const command = parseCommand(message.text);
  if (command) return handleCommand(command, chatId, worker, session, openReport);

  const media = extractMedia(message);
  if (media) {
    return handleIncomingMedia(chatId, worker, session, media, message.caption ?? null, openReport);
  }

  const text = (message.text ?? "").trim();
  if (!text) return;

  // A tapped button from the standing menu is just its command by another name.
  // Checked after location/media so it can never swallow a real submission, but
  // ahead of the state machine: the bar is visible in every state, and a tap
  // that silently became a note is how people got stuck mid-flow. A typed
  // description that reads exactly like a button label is the accepted loss.
  const tapped = buttonCommand(text);
  if (tapped) return handleCommand(tapped, chatId, worker, session, openReport);

  switch (session.state) {
    case "awaiting_record":
      // no media came — the typed text IS the record
      return startTextRecord(chatId, worker, session, text, openReport);
    case "adding_note":
      return saveNoteFromText(chatId, worker, session, text);
    case "editing_note":
      return saveEditedNote(chatId, worker, session, text);
    case "typing_date":
      return saveDateFromText(chatId, worker, session, text);
    case "choosing_project_for_media":
      await send(chatId, "Pick a project from the buttons above first.");
      return;
    default:
      // anything else typed while a record is open belongs to that record
      if (openReport) return joinOpenRecord(chatId, worker, session, openReport, text);
      await send(chatId, HELP_TEXT);
  }
}

/**
 * Nobody registers themselves. Workers exist because an admin created them,
 * and the bot only ever reads that list — so an unknown sender is told what to
 * do and nothing is written.
 */
async function handleUnregistered(
  chatId: number,
  session: Session,
  _from: TgUser,
): Promise<void> {
  saveSessionSoon(session, { state: "idle", draft: {} });
  await send(
    chatId,
    "You're not set up to use this bot. Ask your admin to add you, then send any message here.",
  );
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
//     silent would lose work (a failed upload, an unlinked group).

/** How long one sender's loose photos keep landing in the same report. */
const GROUP_REPORT_WINDOW_MS = 60 * 60_000;

const GROUP_GREETING = "I'll archive photos posted here. Which site is this group for?";

const GROUP_LINK_PROMPT = "📁 I'm not filing this group anywhere yet. Which site is it for?";

const GROUP_HELP = [
  "📷 Photos, videos and files posted here are archived to this group's site — just post, I stay quiet (👍 = saved).",
  "/link to set the site · /unlink to stop · check in/out is personal, DM me.",
].join("\n");

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
 * Resolve only workers provisioned by an admin; group activity never creates
 * users. `known` is what bot_context already found for this Telegram id.
 */
function resolveGroupSender(_from: TgUser, known: Worker | null): Worker | null {
  return known?.status === "active" ? known : null;
}

function handleGroupMessage(
  message: TgMessage,
  from: TgUser,
  link: GroupLink | null,
  sender: Worker | null,
): Promise<void> {
  const command = parseCommand(message.text);
  if (command) return handleGroupCommand(command, message, link, sender);

  const media = extractMedia(message);
  if (media) return handleGroupMedia(message, from, link, sender, media);

  // Crew chatter is not a report.
  return Promise.resolve();
}

async function handleGroupCommand(
  command: string,
  message: TgMessage,
  link: GroupLink | null,
  sender: Worker | null,
): Promise<void> {
  const chatId = message.chat.id;

  switch (command) {
    case "link":
      return groupStartLink(message, sender);
    case "unlink":
      return groupUnlink(message, sender, link);
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

async function groupStartLink(message: TgMessage, worker: Worker | null): Promise<void> {
  const chatId = message.chat.id;
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
  worker: Worker | null,
  link: GroupLink | null,
): Promise<void> {
  const chatId = message.chat.id;
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
    .select(REPORT_COLS)
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
  await addNote(report.id, report.worker_id, caption);
  // keep the in-memory mirror in step with the trigger's
  report.note = report.note ? `${report.note}\n${caption}` : caption;
}

async function handleGroupMedia(
  message: TgMessage,
  from: TgUser,
  link: GroupLink | null,
  sender: Worker | null,
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

  const filer = resolveGroupSender(from, sender);
  if (!filer) {
    await replyTo(chatId, message.message_id, GROUP_NOT_A_WORKER);
    return;
  }

  let report: Report | null = null;
  let created = false;

  if (media.media_group_id) {
    report = await findAlbumReport(media.media_group_id);
  } else if (!caption) {
    // Uncaptioned singles are a photo burst — continue the sender's current
    // update. A CAPTIONED single is a NEW status ("pour done, no defects") and
    // must stand as its own report, even a minute after the last one; crews
    // post several distinct statuses per site per day.
    report = await findRecentGroupReport(filer.id, link.project_id);
  }

  if (report) {
    if (caption) await appendGroupNote(report, caption);
  } else {
    const fresh = await createReport(
      filer.id,
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
 * Group taps. Only the site picker exists here, and it deliberately does not
 * read or write a session — the tapper is one member of many.
 */
async function handleGroupCallback(
  query: TgCallbackQuery,
  chatId: number,
  messageId: number | undefined,
  worker: Worker | null,
): Promise<void> {
  const parts = (query.data ?? "").split(":");
  if (parts[0] !== "gl") {
    // a DM-flow button that somehow surfaced in a group: acknowledge, do nothing
    await answerCallback(query.id);
    return;
  }

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
  openReport: Report | null,
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
      // /cancel aborts the QUESTION, not the record. Closing an open record here
      // meant a worker who mistyped mid-flow silently lost the ✅ Done step —
      // finalising is now only ever an explicit confirm.
      saveSessionSoon(session, { state: "idle", draft: cancelDraft(session.draft, openReport) });
      await send(
        chatId,
        pend?.length
          ? `Cancelled — discarded ${pend.length} unsaved file(s).`
          : openReport
          ? `Cancelled. ${openReport.job_ref ?? "Your record"} is still open — tap ✅ Done when you're finished.`
          : "Cancelled.",
        { reply_markup: MAIN_KEYBOARD },
      );
      return;
    }
    case "send":
      return cmdSend(chatId, session, openReport);
    case "today":
      return cmdToday(chatId, worker);
    case "retired":
      // Re-sending the keyboard is the actual fix: it replaces the stale one
      // holding the button they just tapped.
      await send(
        chatId,
        "That's not part of the bot any more — site records only.",
        { reply_markup: MAIN_KEYBOARD },
      );
      return;
    default:
      await send(chatId, "I don't know that command. Send /help to see what I can do.", {
        reply_markup: MAIN_KEYBOARD,
      });
  }
}

/**
 * "Send records" opens a record of any shape: photos, videos, files — or plain
 * text on its own. Forcing an image on someone whose whole update is "no
 * leakages, all good" just loses that update.
 */
async function cmdSend(chatId: number, session: Session, openReport: Report | null): Promise<void> {
  // A record still open keeps its card link, so whatever comes next edits that
  // card instead of leaving a stale one above a fresh copy.
  saveSessionSoon(session, {
    state: "awaiting_record",
    draft: openReport ? session.draft : resetDraft(session.draft),
  });
  await send(
    chatId,
    openReport
      ? `📷 Attach photos, videos or files (📎 below) — or just type what happened.\n` +
        `It goes on ${openReport.job_ref ?? "your open record"} until you tap ✅ Done.`
      : `📷 Attach photos, videos or files (📎 below) — or just type what happened.\n` +
        `I'll ask which site it's for.`,
    // MAIN_KEYBOARD is persistent, so the slot is free for a visible way out
    { reply_markup: CANCEL_MARKUP },
  );
}

/** A typed update with no media is a full record in its own right. */
async function startTextRecord(
  chatId: number,
  worker: Worker,
  session: Session,
  text: string,
  openReport: Report | null,
): Promise<void> {
  // a record still open takes the words: one update, not two half ones
  if (openReport) return joinOpenRecord(chatId, worker, session, openReport, text);

  const rows = await projectKeyboard(worker.id, "pjm");
  if (!rows) {
    await send(chatId, "No active projects yet. Ask your admin to set one up.");
    return;
  }
  saveSessionSoon(session, {
    state: "choosing_project_for_media",
    draft: { ...resetDraft(session.draft), pending_note: text.slice(0, 2000) },
  });
  await send(chatId, await newRecordPrompt("📝 New record", worker, null), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: withMediaCancel(rows) },
  });
}

/** How many records the day card lists before it stops. */
const TODAY_LIST_LIMIT = 8;

/**
 * The worker's own view of their day. Read-only on purpose: a record of work is
 * only trusted if the person who filed it can see it back, and nothing here
 * writes, so it is safe to tap at any point in any flow.
 */
async function cmdToday(chatId: number, worker: Worker): Promise<void> {
  const today = await localDate();
  const reports = await supabase
    .from("reports")
    .select(
      "id, job_ref, created_at, projects(code), report_media(media_type), report_notes(body, created_at)",
    )
    .eq("worker_id", worker.id)
    .eq("report_date", today)
    .order("created_at", { ascending: false });
  if (reports.error) throw reports.error;

  const rows = ((reports.data ?? []) as {
    job_ref: string | null;
    projects?: { code?: string } | null;
    report_media?: { media_type: string }[] | null;
    report_notes?: ReportNote[] | null;
  }[]).map((r) => ({
    jobRef: r.job_ref ?? "—",
    notes: sortNotes(r.report_notes ?? []),
    code: r.projects?.code ?? "site",
    types: (r.report_media ?? []).map((m) => m.media_type),
  }));

  const title = `📄 Your day — ${await fmtDateFull(today)}`;

  if (rows.length === 0) {
    await send(
      chatId,
      card(title, [["Records", "0"]], "Nothing logged yet. Tap 📷 Send records when you've got something."),
      { parse_mode: "HTML", reply_markup: MAIN_KEYBOARD },
    );
    return;
  }

  const allTypes = rows.flatMap((r) => r.types);
  const photos = allTypes.filter((t) => t === "photo").length;
  const summary: [string, string][] = [
    ["Records", String(rows.length)],
    allTypes.length === photos
      ? ["Photos", String(photos)]
      : ["Files", String(allTypes.length)],
  ];

  const listed = rows.slice(0, TODAY_LIST_LIMIT).map((r) => {
    const parts = [esc(r.jobRef), esc(r.code)];
    if (r.types.length > 0) parts.push(esc(mediaLabel(r.types)));
    // one line per record here, so it quotes the latest note and counts the rest
    const latest = r.notes[r.notes.length - 1];
    parts.push(
      latest
        ? `“${esc(oneLine(latest.body, 40))}”${r.notes.length > 1 ? ` (+${r.notes.length - 1} more)` : ""}`
        : "no description",
    );
    return `• ${parts.join(" · ")}`;
  });
  if (rows.length > listed.length) {
    listed.push(`• …and ${rows.length - listed.length} more`);
  }

  await send(
    chatId,
    `${card(title, summary)}\nRecords today:\n${listed.join("\n")}`,
    { parse_mode: "HTML", reply_markup: MAIN_KEYBOARD },
  );
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
    .select(REPORT_COLS)
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
    .select(REPORT_COLS)
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
  openReport: Report | null,
): Promise<void> {
  // Part 2+ of an album whose report already exists → attach silently.
  if (media.media_group_id) {
    const report = await findAlbumReport(media.media_group_id);
    if (report) {
      const ok = await storeMedia(report, media);
      if (!ok) await send(chatId, RESEND_WARNING);
      if (caption && report.note === null) await addNote(report.id, worker.id, caption);
      return;
    }
  }

  // A record the worker hasn't closed keeps taking files, however long they take
  // to send them. This is the whole point of the open lifecycle: photos arriving
  // one at a time are one update, and it is theirs to end.
  if (openReport) {
    const ok = await storeMedia(openReport, media);
    if (!ok) {
      await send(chatId, RESEND_WARNING);
      return;
    }
    if (caption) await addNote(openReport.id, worker.id, caption);
    await showOpenRecord(
      chatId,
      session.draft.card_message_id,
      worker,
      session,
      openReport.id,
      { resend: !media.media_group_id },
    );
    return;
  }

  // Answering "add a note" for an earlier, already-closed record → the files
  // still belong to that record rather than opening a second one.
  if (session.state === "adding_note" && session.draft.report_id) {
    const target = await ownedReport(session.draft.report_id, worker.id);
    if (target) {
      const ok = await storeMedia(target, media);
      if (!ok) await send(chatId, RESEND_WARNING);
      if (caption) {
        await addNote(target.id, worker.id, caption);
        saveSessionSoon(session, { state: "idle", draft: resetDraft(session.draft) });
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
    saveSessionSoon(session, {
      state: "choosing_project_for_media",
      draft: { ...session.draft, pending_group: media.media_group_id },
    });
    // Read the batch back rather than assuming one file: album parts land in
    // parallel, so by now more may already be waiting. Only ever runs on the
    // first part of a batch — the rest take the silent path above.
    const waiting = await supabase
      .from("pending_media")
      .select("media")
      .eq("chat_id", chatId);
    const types = ((waiting.data ?? []) as { media: MediaDescriptor }[])
      .map((p) => p.media?.media_type)
      .filter(Boolean);
    await send(
      chatId,
      await newRecordPrompt("📷 New record", worker, types.length > 0 ? types : [media.media_type]),
      { parse_mode: "HTML", reply_markup: { inline_keyboard: withMediaCancel(rows) } },
    );
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
  status: "open" | "final" = "final",
): Promise<{ report: Report; created: boolean }> {
  const { data, error } = await supabase
    .from("reports")
    .insert({
      project_id: projectId,
      worker_id: workerId,
      report_date: await localDate(),
      album_group_id: albumGroupId,
      status,
    })
    .select(REPORT_COLS)
    .single();
  if (error) {
    if (error.code === "23505" && albumGroupId) {
      const existing = await findAlbumReport(albumGroupId);
      if (existing) return { report: existing, created: false };
    }
    throw error;
  }

  // reports.note is a trigger-maintained mirror now — the first caption is a
  // note row like every one after it.
  const report = data as Report;
  if (note && note.trim()) {
    await addNote(report.id, workerId, note);
    report.note = note.trim();
  }
  return { report, created: true };
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
    saveSessionSoon(session, { state: "idle", draft: resetDraft(session.draft) });
    await send(chatId, "That report is no longer open. Send the media again to start over.");
    return;
  }

  // "Add note" must ADD. Overwriting silently destroyed what the worker typed
  // earlier — the one thing a record keeper must never do. Each note is its own
  // timestamped row; corrections happen in the dashboard.
  const existing = await ownedReport(reportId, worker.id);
  if (!existing) {
    saveSessionSoon(session, { state: "idle", draft: resetDraft(session.draft) });
    await send(chatId, NOT_YOURS);
    return;
  }
  await addNote(reportId, worker.id, text);

  // a record still open goes back to its own card, not to a receipt — and to
  // the review card if that's where the worker tapped 📝 Add note
  if (existing.status === "open") {
    if (session.draft.review) {
      return showReviewCard(chatId, session.draft.card_message_id, session, reportId);
    }
    return showOpenRecord(chatId, session.draft.card_message_id, worker, session, reportId);
  }

  saveSessionSoon(session, { state: "idle", draft: resetDraft(session.draft) });
  // hand back the finished card so they can still fix the date or site
  await send(chatId, await recordReceipt(reportId, worker.id), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: reportButtons(reportId) },
  });
}

/**
 * ✏️ Rewrite: the one place text REPLACES a note instead of adding one. Add note
 * must never overwrite, but a worker who picked a single entry and asked to
 * rewrite it means exactly that — anything else would leave the typo behind.
 */
async function saveEditedNote(
  chatId: number,
  worker: Worker,
  session: Session,
  text: string,
): Promise<void> {
  const noteId = session.draft.note_id;
  const note = noteId ? await ownedNote(noteId, worker.id) : null;
  if (!note) {
    saveSessionSoon(session, { state: "idle", draft: resetDraft(session.draft) });
    await send(chatId, noteId ? NOT_YOURS : "That note is no longer open.");
    return;
  }

  const { error } = await supabase
    .from("report_notes")
    .update({ body: text.trim().slice(0, 2000) })
    .eq("id", note.id);
  if (error) throw error;

  await showReviewCard(chatId, session.draft.card_message_id, session, note.report_id);
}

/** Receipt for a record we only hold the id of: read it back, then tally. */
async function recordReceipt(reportId: number, workerId: number): Promise<string> {
  const [c, tally] = await Promise.all([loadRecordCard(reportId), recordsToday(workerId)]);
  if (!c) return "✅ Saved.";
  return await receiptCard(c, tally);
}

/**
 * ✅ Confirm & save: the second, explicit tap — the only thing that finalises a
 * record. Finalising and reading the receipt back run together, and the review
 * card they tapped becomes that receipt, so it costs no Telegram round trip.
 */
async function cbFinishRecord(
  chatId: number,
  messageId: number | undefined,
  session: Session,
  worker: Worker,
  reportId: number,
): Promise<void> {
  const [, text] = await Promise.all([
    closeReport(reportId, worker.id),
    recordReceipt(reportId, worker.id),
  ]);
  saveSessionSoon(session, { state: "idle", draft: resetDraft(session.draft) });

  const extra = {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: reportButtons(reportId) },
  };
  // the open card becomes its own answer, so the chat reads as a transcript
  if (messageId) await edit(chatId, messageId, text, extra);
  else await send(chatId, text, extra);
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
    saveSessionSoon(session, { state: "idle", draft: resetDraft(session.draft) });
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

  const cardId = session.draft.card_message_id;
  const fromReview = session.draft.review === true;
  saveSessionSoon(session, { state: "idle", draft: resetDraft(session.draft) });
  await send(chatId, `✅ Date set to ${await fmtDate(parsed)}.`);
  // typing a date on the way out lands back on the review, not a step before it
  if (fromReview) await showReviewCard(chatId, cardId, session, reportId);
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
  const group = chat ? isGroupChat(chat) : false;
  if (!group && chat?.type && chat.type !== "private") {
    await answerCallback(query.id);
    return;
  }

  // worker + session + open record in one round trip, same as for messages
  const ctx = await loadBotContext(chatId, query.from.id, query.from.username);
  // a group session belongs to nobody in particular — only the worker is used
  if (group) return handleGroupCallback(query, chatId, messageId, ctx.worker);

  const { session, worker } = ctx;
  if (!worker || worker.status !== "active") {
    await answerCallback(
      query.id,
      worker ? "Your account isn't active." : "Ask an admin to add your Telegram username.",
    );
    return;
  }
  await answerCallback(query.id);

  const parts = query.data.split(":");
  const action = parts[0];

  // every report-scoped action → ownership is checked before dispatch. The
  // note-scoped ones (rvnx/rvne/rvnd) carry a note id instead and are checked
  // by ownedNote, which joins back to the owning report.
  const reportActions = [
    "rn",
    "rd",
    "rdd",
    "rp",
    "rpp",
    "nskip",
    "nfin",
    "rvok",
    "rvpv",
    "rvn",
    "rvbk",
    "rvdel",
    "rvdel2",
  ];
  let report: Report | null = null;
  if (reportActions.includes(action)) {
    const reportId = Number(parts[1]);
    // the open record came back with bot_context, already scoped to this worker
    report = ctx.openReport?.id === reportId
      ? ctx.openReport
      : await ownedReport(reportId, worker.id);
    if (!report) {
      await send(chatId, NOT_YOURS);
      return;
    }
  }

  switch (action) {
    // nskip is the retired "Skip — no description" button; old cards still carry
    // it, and skipping was only ever a way of saying the record was finished.
    // Neither saves any more — ✅ Done is the review step, not the commit.
    case "nskip":
    case "nfin":
      return showReviewCard(chatId, messageId, session, report!.id, {
        queued: messageId !== undefined,
      });
    case "rvok":
      return cbFinishRecord(chatId, messageId, session, worker, report!.id);
    case "rvbk":
      return showOpenRecord(chatId, messageId, worker, session, report!.id, {
        queued: messageId !== undefined,
      });
    case "rvpv":
      return cbPreviewMedia(chatId, session, report!.id);
    case "rvn":
      return cbEditNotes(chatId, messageId, session, report!.id);
    case "rvnx":
      return cbShowNote(chatId, messageId, session, worker, Number(parts[1]));
    case "rvne":
      return cbAskNoteRewrite(chatId, session, worker, Number(parts[1]));
    case "rvnd":
      return cbDeleteNote(chatId, messageId, session, worker, Number(parts[1]));
    case "rvdel":
      return cbConfirmDiscard(chatId, messageId, session, report!.id);
    case "rvdel2":
      return cbDiscardRecord(chatId, messageId, session, worker, report!.id);
    case "cx":
      return cbCancelPrompt(chatId, messageId, session, ctx.openReport, false);
    case "cxm":
      return cbCancelPrompt(chatId, messageId, session, ctx.openReport, true);
    case "pjm":
      return cbPickProjectForMedia(
        chatId,
        messageId,
        worker,
        session,
        ctx.openReport,
        Number(parts[1]),
      );
    case "rn":
      return cbAskNote(chatId, session, Number(parts[1]));
    case "rd":
      return cbShowDateOptions(chatId, messageId, Number(parts[1]));
    case "rdd":
      return cbSetRelativeDate(chatId, messageId, worker, session, report!, Number(parts[2]));
    case "rp":
      return cbShowProjectOptions(chatId, messageId, worker, Number(parts[1]));
    case "rpp":
      return cbSetReportProject(chatId, messageId, worker, session, report!, Number(parts[2]));
    default:
      console.error("unknown callback data", query.data);
  }
}

async function cbPickProjectForMedia(
  chatId: number,
  messageId: number | undefined,
  worker: Worker,
  session: Session,
  previous: Report | null,
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
    const note = session.draft.pending_note; // the draft is rewritten below
    const { report } = await createReport(worker.id, projectId, note, null, "open");
    closePrevious(previous, report.id, worker.id);
    // the site question becomes the open record's card, so we know its id
    await showOpenRecord(chatId, messageId, worker, session, report.id, { queued: true });
    return;
  }

  if (pending.length === 0) {
    // stale tap — the batch was already saved or cancelled
    saveSessionSoon(session, { state: "idle", draft: resetDraft(session.draft) });
    const line = "No files waiting — send them again and I'll ask for the site.";
    if (messageId) await resolvePrompt(chatId, messageId, line);
    else await send(chatId, line);
    return;
  }

  const caption = pending.find((p) => p.caption)?.caption ?? null;
  const group = session.draft.pending_group ??
    pending.find((p) => p.media.media_group_id)?.media.media_group_id ?? null;

  const { report, created } = await createReport(worker.id, projectId, caption, group, "open");
  if (created) closePrevious(previous, report.id, worker.id);

  // bounded parallelism: 3 at a time keeps a big album inside the wall clock
  const storedTypes: string[] = [];
  for (let i = 0; i < pending.length; i += 3) {
    const batch = pending.slice(i, i + 3);
    const results = await Promise.all(batch.map((p) => storeMedia(report, p.media)));
    results.forEach((ok, n) => {
      if (ok) storedTypes.push(batch[n].media.media_type);
    });
  }
  const stored = storedTypes.length;
  // the batch is filed; clearing the staging rows can overlap the reply
  background(Promise.resolve(supabase.from("pending_media").delete().eq("chat_id", chatId)));

  if (stored === 0) {
    if (created) await supabase.from("reports").delete().eq("id", report.id);
    saveSessionSoon(session, { state: "idle", draft: resetDraft(session.draft) });
    await send(chatId, "⚠️ None of the files could be saved — please resend them.");
    return;
  }
  // The site question turns into the record's own card — still open, and every
  // later photo or note edits this one message rather than adding another.
  if (created) {
    await showOpenRecord(chatId, messageId, worker, session, report.id, { queued: true });
  }
  if (stored < pending.length) {
    await send(
      chatId,
      `⚠️ ${pending.length - stored} of ${pending.length} files couldn't be saved — please resend them.`,
    );
  }
}

async function cbAskNote(
  chatId: number,
  session: Session,
  reportId: number,
): Promise<void> {
  saveSessionSoon(session, {
    state: "adding_note",
    draft: { ...session.draft, report_id: reportId },
  });
  // Say plainly that this adds a line, so nobody expects a replace. Only the
  // last note is quoted — the earlier ones are already on the card above.
  const prior = (await latestNote(reportId))?.trim();
  await send(
    chatId,
    prior
      ? `📝 Send the extra detail — it gets added under:\n<i>${esc(oneLine(prior, 90))}</i>`
      : "📝 Send the description for this record.",
    prior
      ? { parse_mode: "HTML", reply_markup: CANCEL_MARKUP }
      : { reply_markup: CANCEL_MARKUP },
  );
}

// ---------------------------------------------------------------- review step

const PREVIEW_UNAVAILABLE = "Preview unavailable — the files are saved.";

/** Telegram's own cap on one media group. */
const MEDIA_GROUP_MAX = 10;

/** Documents can't ride a media group, so they cost a round trip each. */
const PREVIEW_DOC_MAX = 5;

/**
 * 🖼 Preview: hand the worker's own files back before they commit. Every stored
 * file kept its telegram_file_id, so Telegram serves its cached copy — no
 * download, no upload, near-instant. An expired id is not worth failing over:
 * the files are archived either way, so say so and move on.
 */
async function cbPreviewMedia(
  chatId: number,
  session: Session,
  reportId: number,
): Promise<void> {
  const { data, error } = await supabase
    .from("report_media")
    .select("telegram_file_id, media_type")
    .eq("report_id", reportId)
    .order("id");
  if (error) throw error;

  const files = ((data ?? []) as { telegram_file_id: string | null; media_type: string }[])
    .filter((f): f is { telegram_file_id: string; media_type: string } => Boolean(f.telegram_file_id));

  const groupable = files.filter((f) => f.media_type === "photo" || f.media_type === "video");
  const docs = files.filter((f) => f.media_type === "document");

  let shown = 0;
  for (let i = 0; i < groupable.length; i += MEDIA_GROUP_MAX) {
    const chunk = groupable.slice(i, i + MEDIA_GROUP_MAX);
    // Telegram rejects a media group of one — a lone file (or the remainder of
    // an eleventh) goes out as itself.
    if (chunk.length === 1) {
      const one = chunk[0];
      const method = one.media_type === "video" ? "sendVideo" : "sendPhoto";
      const key = one.media_type === "video" ? "video" : "photo";
      if (await tg(method, { chat_id: chatId, [key]: one.telegram_file_id })) shown++;
      continue;
    }
    const sent = await tg("sendMediaGroup", {
      chat_id: chatId,
      media: chunk.map((f) => ({
        type: f.media_type === "video" ? "video" : "photo",
        media: f.telegram_file_id,
      })),
    });
    if (sent) shown += chunk.length;
  }
  for (const d of docs.slice(0, PREVIEW_DOC_MAX)) {
    if (await tg("sendDocument", { chat_id: chatId, document: d.telegram_file_id })) shown++;
  }

  if (files.length > 0 && shown === 0) {
    await send(chatId, PREVIEW_UNAVAILABLE);
  } else if (docs.length > PREVIEW_DOC_MAX) {
    await send(chatId, `…and ${docs.length - PREVIEW_DOC_MAX} more file(s) — all saved.`);
  }

  // the files pushed the card off the screen — put the buttons back within reach
  await showReviewCard(chatId, undefined, session, reportId);
}

/** The record's notes, one button each, so a single entry can be fixed. */
async function cbEditNotes(
  chatId: number,
  messageId: number | undefined,
  session: Session,
  reportId: number,
): Promise<void> {
  const notes = await listNotes(reportId);
  if (notes.length === 0) {
    return showReviewCard(chatId, messageId, session, reportId, {
      queued: messageId !== undefined,
    });
  }

  const rows: InlineButton[][] = [];
  for (const n of notes) {
    rows.push([{
      text: `${await fmtTime(n.created_at)}  ${oneLine(n.body, 28)}`,
      callback_data: `rvnx:${n.id}`,
    }]);
  }
  rows.push([{ text: "↩️ Back", callback_data: `nfin:${reportId}` }]);

  await showPanel(
    chatId,
    messageId,
    session,
    reportId,
    "<b>✏️ Which note?</b>\nTap one to rewrite or delete it.",
    rows,
    messageId !== undefined,
  );
}

async function cbShowNote(
  chatId: number,
  messageId: number | undefined,
  session: Session,
  worker: Worker,
  noteId: number,
): Promise<void> {
  const note = await ownedNote(noteId, worker.id);
  if (!note) {
    await send(chatId, NOT_YOURS);
    return;
  }
  await showPanel(
    chatId,
    messageId,
    session,
    note.report_id,
    `<b>📝 Note · ${await fmtTime(note.created_at)}</b>\n<pre>${esc(note.body)}</pre>`,
    [
      [
        { text: "✏️ Rewrite", callback_data: `rvne:${note.id}` },
        { text: "🗑 Delete", callback_data: `rvnd:${note.id}` },
      ],
      [{ text: "↩️ Back", callback_data: `rvn:${note.report_id}` }],
    ],
    messageId !== undefined,
  );
}

async function cbAskNoteRewrite(
  chatId: number,
  session: Session,
  worker: Worker,
  noteId: number,
): Promise<void> {
  const note = await ownedNote(noteId, worker.id);
  if (!note) {
    await send(chatId, NOT_YOURS);
    return;
  }
  saveSessionSoon(session, {
    state: "editing_note",
    draft: { ...session.draft, report_id: note.report_id, note_id: note.id },
  });
  await send(
    chatId,
    `✏️ Send the new wording — it REPLACES:\n<i>${esc(oneLine(note.body, 90))}</i>`,
    { parse_mode: "HTML", reply_markup: CANCEL_MARKUP },
  );
}

async function cbDeleteNote(
  chatId: number,
  messageId: number | undefined,
  session: Session,
  worker: Worker,
  noteId: number,
): Promise<void> {
  const note = await ownedNote(noteId, worker.id);
  if (!note) {
    await send(chatId, NOT_YOURS);
    return;
  }
  const { error } = await supabase.from("report_notes").delete().eq("id", note.id);
  if (error) throw error;
  // back to the list, or to the review once the last one is gone
  await cbEditNotes(chatId, messageId, session, note.report_id);
}

/**
 * 🗑 Discard asks first and names what goes: the files are already in the bucket
 * by this point, so there is nothing to undo once it runs.
 */
async function cbConfirmDiscard(
  chatId: number,
  messageId: number | undefined,
  session: Session,
  reportId: number,
): Promise<void> {
  const c = await loadRecordCard(reportId);
  const files = c?.mediaTypes.length ?? 0;
  await showPanel(
    chatId,
    messageId,
    session,
    reportId,
    esc(`🗑 Discard this record and its ${files} file(s)? This cannot be undone.`),
    [[
      { text: "🗑 Yes, discard", callback_data: `rvdel2:${reportId}` },
      { text: "↩️ No, keep it", callback_data: `nfin:${reportId}` },
    ]],
    messageId !== undefined,
  );
}

async function cbDiscardRecord(
  chatId: number,
  messageId: number | undefined,
  session: Session,
  worker: Worker,
  reportId: number,
): Promise<void> {
  const { data, error } = await supabase
    .from("report_media")
    .select("storage_path")
    .eq("report_id", reportId);
  if (error) throw error;

  // Bucket first: the row deletion cascades report_media away, and an object
  // with no row pointing at it is invisible rubbish nobody will ever clean up.
  const paths = ((data ?? []) as { storage_path: string | null }[])
    .map((m) => m.storage_path)
    .filter((p): p is string => Boolean(p));
  if (paths.length > 0) {
    const removed = await supabase.storage.from("site-media").remove(paths);
    // a failure here is a stray object, not a reason to keep a record the
    // worker just said they don't want
    if (removed.error) console.error("discard: storage remove failed", removed.error);
  }

  const del = await supabase
    .from("reports")
    .delete()
    .eq("id", reportId)
    .eq("worker_id", worker.id);
  if (del.error) throw del.error;

  saveSessionSoon(session, { state: "idle", draft: resetDraft(session.draft) });
  const line = "🗑 Discarded. Nothing was saved.";
  if (messageId) await edit(chatId, messageId, line, { reply_markup: { inline_keyboard: [] } });
  else await send(chatId, line);
}

/**
 * ❌ Cancel on any prompt. It abandons the question, never the record: an open
 * record keeps its card link so the next photo still joins it. `purgeMedia` is
 * the site picker's variant — its files are parked in pending_media and would
 * otherwise be adopted by whatever batch came next.
 */
async function cbCancelPrompt(
  chatId: number,
  messageId: number | undefined,
  session: Session,
  openReport: Report | null,
  purgeMedia: boolean,
): Promise<void> {
  if (purgeMedia) {
    const { error } = await supabase.from("pending_media").delete().eq("chat_id", chatId);
    if (error) throw error;
  }
  saveSessionSoon(session, { state: "idle", draft: cancelDraft(session.draft, openReport) });

  const line = purgeMedia ? "Cancelled — files discarded." : "Cancelled.";
  // the prompt becomes its own answer rather than leaving a question hanging
  if (messageId) await edit(chatId, messageId, line, { reply_markup: { inline_keyboard: [] } });
  else await send(chatId, line);
}

async function cbShowDateOptions(
  chatId: number,
  messageId: number | undefined,
  reportId: number,
): Promise<void> {
  // Days are picked, never typed. A worker on a site with wet gloves should not
  // be parsing "03/08/2026 or 2026-08-03" — and a typo there silently files the
  // record under the wrong day, which is exactly what this system exists to
  // prevent. Backfilling more than a week late isn't a real case.
  const zone = await tz();
  const labels = ["Today", "Yesterday"];
  const rows: InlineButton[][] = [];
  let row: InlineButton[] = [];

  for (let back = 0; back < 7; back++) {
    const day = await localDate(back);
    const text = back < 2
      ? labels[back]
      : new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric" })
        .format(new Date(`${day}T12:00:00Z`));
    row.push({ text, callback_data: `rdd:${reportId}:${back}` });
    if (row.length === 2) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);

  if (messageId) await editKeyboard(chatId, messageId, rows);
  else await send(chatId, "Which date?", { reply_markup: { inline_keyboard: rows } });
}

/**
 * Refresh the saved-report card in place. Editing the card beats sending another
 * "✅ Date set to…" line each time — after three tweaks the chat is all receipts
 * and the worker can no longer see what the report actually says.
 */
/**
 * Redraw whichever card the record currently is: an open one keeps its ✅ Done
 * button, a finished one goes back to the saved receipt. Correcting the date on
 * an open record must never quietly close it.
 */
function refreshRecordCard(
  chatId: number,
  messageId: number,
  worker: Worker,
  session: Session,
  report: Report,
): Promise<void> {
  if (report.status === "open") {
    // an edit reached from the review goes back to the review, not a step before
    if (session.draft.review) {
      return showReviewCard(chatId, messageId, session, report.id, { queued: true });
    }
    return showOpenRecord(chatId, messageId, worker, session, report.id, { queued: true });
  }
  return refreshReportCard(chatId, messageId, report.id);
}

async function refreshReportCard(
  chatId: number,
  messageId: number | undefined,
  reportId: number,
): Promise<void> {
  if (!messageId) return;
  const c = await loadRecordCard(reportId);
  if (!c) return;

  // the same card as the receipt, minus the daily tally — that line belongs to
  // the moment the record was filed, not to every later correction
  const rows: [string, string][] = [
    ["Ref", c.jobRef],
    ["Site", siteLine(c)],
    ["Date", await fmtDateFull(c.reportDate)],
  ];
  if (c.notes.length === 0) rows.push(["Description", "—"]);
  if (c.mediaTypes.length > 0) rows.push(["Files", mediaLabel(c.mediaTypes)]);

  const footer = c.name ? `\n${esc(`Saved to the ${c.name} archive.`)}` : "";
  await tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: `${card("✅ Record saved", rows)}${await notesSection(c.notes)}${footer}`,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: reportButtons(reportId) },
  });
}

async function cbSetRelativeDate(
  chatId: number,
  messageId: number | undefined,
  worker: Worker,
  session: Session,
  report: Report,
  daysBack: number,
): Promise<void> {
  const date = await localDate(Number.isFinite(daysBack) ? daysBack : 0);
  const { error } = await supabase.from("reports").update({ report_date: date }).eq(
    "id",
    report.id,
  );
  if (error) throw error;
  if (messageId) await refreshRecordCard(chatId, messageId, worker, session, report);
  else await send(chatId, `✅ Date set to ${await fmtDate(date)}.`);
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
  worker: Worker,
  session: Session,
  report: Report,
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
    .eq("id", report.id);
  if (error) throw error;
  if (messageId) await refreshRecordCard(chatId, messageId, worker, session, report);
  else await send(chatId, `✅ Moved to ${project.code} — ${project.name}.`);
}

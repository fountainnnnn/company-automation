// Focus briefing — an LLM reading of what needs attention across sites and teams.
//
// Runs server-side for one reason: the model API key must never reach the
// dashboard bundle, which is public. The key lives in app_secrets (service-role
// only), exactly like the Telegram token.
//
// Every call is cached. Generating on each page load would spend money to
// re-summarise data that has not changed, so a briefing younger than the
// cooldown is served as-is unless the caller explicitly asks for a refresh.

import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

/** A briefing younger than this is reused rather than regenerated. */
const COOLDOWN_MS = 10 * 60_000;

const MODEL = "deepseek-chat";
const API_URL = "https://api.deepseek.com/chat/completions";

const SYSTEM_PROMPT = [
  "You are an operations analyst for a Singapore construction contractor.",
  "You are given a JSON snapshot of site reporting and attendance activity.",
  "Write a short briefing for the office on what needs attention.",
  "",
  "Rules:",
  "- Report only what the snapshot supports. Never invent sites, teams, numbers or events.",
  "- A site or team with no activity is worth flagging, but say plainly that the record is",
  "  absent — do not assert that no work happened, because you cannot know that.",
  "- Prefer concrete, checkable statements over advice.",
  "- Be brief. The reader is scanning, not studying.",
  "",
  'Reply as JSON: {"summary": string, "focus": [{"title": string, "detail": string,',
  '"severity": "high"|"medium"|"low", "scope": string}]}',
  "",
  "summary: two or three sentences on the overall state.",
  "focus: at most 5 items, most important first. scope is a site code, a team",
  'like "Team 3", or "All sites". Omit focus items entirely if nothing needs attention.',
].join("\n");

interface FocusItem {
  title: string;
  detail: string;
  severity: string;
  scope: string;
}

// The dashboard calls this from the browser, so the preflight has to be
// answered or the request never reaches the handler.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

/**
 * The model key. A function secret wins if one is set — it is the easier thing
 * to rotate (`supabase secrets set`) and never touches the database; otherwise
 * fall back to app_secrets, where the Telegram credentials already live.
 */
async function apiKey(): Promise<string | null> {
  const fromEnv = Deno.env.get("DEEPSEEK_API_KEY")?.trim();
  if (fromEnv) return fromEnv;

  const { data, error } = await supabase
    .from("app_secrets")
    .select("value")
    .eq("key", "deepseek_api_key")
    .maybeSingle();
  if (error) throw error;
  const value = (data?.value as string | undefined)?.trim();
  return value ? value : null;
}

/**
 * Two callers, two proofs. The scheduler presents a shared secret (the
 * telegram-webhook pattern); a person presents their Supabase session and must
 * be an admin. Neither is optional: the publishable key ships in the dashboard
 * bundle, so "any valid JWT" would let anyone spend model credits.
 */
type Auth =
  | { ok: true; userId: string | null }
  | { ok: false; status: number; error: string };

async function authorize(req: Request): Promise<Auth> {
  const cron = req.headers.get("x-cron-secret");
  if (cron) {
    const { data } = await supabase
      .from("app_secrets")
      .select("value")
      .eq("key", "summary_cron_secret")
      .maybeSingle();
    const expected = (data?.value as string | undefined)?.trim();
    if (expected && cron === expected) return { ok: true, userId: null };
    return { ok: false, status: 401, error: "unauthorized" };
  }

  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  // An anon/publishable key is a valid JWT but resolves to no user, so this
  // rejects it — which is the point.
  const { data } = await supabase.auth.getUser(header.slice(7));
  const userId = data?.user?.id;
  if (!userId) return { ok: false, status: 401, error: "unauthorized" };

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  if (profile?.role !== "admin") {
    return { ok: false, status: 403, error: "admin_only" };
  }
  return { ok: true, userId };
}

/**
 * Newest report or check-in. On a quiet night the scheduler would otherwise pay
 * to re-summarise a snapshot that has not moved.
 */
async function lastActivityAt(): Promise<string | null> {
  const [reports, attendance] = await Promise.all([
    supabase.from("reports").select("created_at").order("created_at", { ascending: false })
      .limit(1).maybeSingle(),
    supabase.from("attendance").select("check_in_at").order("check_in_at", { ascending: false })
      .limit(1).maybeSingle(),
  ]);
  const stamps = [
    reports.data?.created_at as string | undefined,
    attendance.data?.check_in_at as string | undefined,
  ].filter(Boolean) as string[];
  if (stamps.length === 0) return null;
  return stamps.sort().at(-1)!;
}

/** Newest briefing, or null if there has never been one. */
async function latest() {
  const { data, error } = await supabase
    .from("site_summaries")
    .select("id, generated_at, window_days, model, summary, focus")
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/**
 * Ask the model. Returns parsed content, or throws with a message the dashboard
 * can show — a failure here is operational, not a bug, so it must be legible.
 */
async function generate(key: string, snapshot: unknown): Promise<{ summary: string; focus: FocusItem[] }> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(snapshot) },
      ],
      response_format: { type: "json_object" },
      max_tokens: 900,
      stream: false,
    }),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    if (res.status === 401 || res.status === 403) {
      throw new Error("The DeepSeek key was rejected — check the app_secrets row.");
    }
    if (res.status === 402) {
      throw new Error("The DeepSeek account is out of credit.");
    }
    if (res.status === 429) {
      throw new Error("DeepSeek is rate-limiting — try again shortly.");
    }
    throw new Error(`DeepSeek returned ${res.status}: ${detail}`);
  }

  const body = await res.json();
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("DeepSeek returned no content.");

  let parsed: { summary?: unknown; focus?: unknown };
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("DeepSeek returned malformed JSON.");
  }

  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  if (!summary) throw new Error("DeepSeek returned no summary.");

  // Trust nothing about the shape — the model is not a schema.
  const focus: FocusItem[] = Array.isArray(parsed.focus)
    ? (parsed.focus as Record<string, unknown>[])
      .filter((f) => f && typeof f.title === "string")
      .slice(0, 5)
      .map((f) => ({
        title: String(f.title).slice(0, 120),
        detail: typeof f.detail === "string" ? f.detail.slice(0, 400) : "",
        severity: ["high", "medium", "low"].includes(String(f.severity))
          ? String(f.severity)
          : "medium",
        scope: typeof f.scope === "string" ? f.scope.slice(0, 60) : "All sites",
      }))
    : [];

  return { summary, focus };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let force = false;
  let days = 7;
  try {
    const body = await req.json();
    force = body?.force === true;
    if (Number.isFinite(body?.days)) days = Math.min(30, Math.max(1, Number(body.days)));
  } catch {
    // no body is fine — defaults apply
  }

  const auth = await authorize(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  try {
    const cached = await latest();
    if (!force && cached) {
      const age = Date.now() - new Date(cached.generated_at).getTime();
      if (age < COOLDOWN_MS) return json({ ...cached, cached: true });

      // Past the cooldown but nothing has happened since — the briefing would
      // come back identical, so don't pay for it.
      const activity = await lastActivityAt();
      if (activity && new Date(activity) <= new Date(cached.generated_at)) {
        return json({ ...cached, cached: true, reason: "no_new_activity" });
      }
    }

    const key = await apiKey();
    if (!key) {
      return json({
        error: "no_api_key",
        message:
          "No DeepSeek key configured. Add one to app_secrets as 'deepseek_api_key'.",
      }, 503);
    }

    const snap = await supabase.rpc("focus_snapshot", { days });
    if (snap.error) throw snap.error;

    const { summary, focus } = await generate(key, snap.data);

    // Who asked, when it is possible to tell. verify_jwt guarantees the caller
    // is signed in; resolving the id is a nicety, so never fail the run on it.
    let generatedBy: string | null = null;
    const auth = req.headers.get("authorization");
    if (auth?.startsWith("Bearer ")) {
      const { data } = await supabase.auth.getUser(auth.slice(7));
      generatedBy = data?.user?.id ?? null;
    }

    const insert = await supabase
      .from("site_summaries")
      .insert({
        window_days: days,
        model: MODEL,
        summary,
        focus,
        snapshot: snap.data,
        generated_by: generatedBy,
      })
      .select("id, generated_at, window_days, model, summary, focus")
      .single();
    if (insert.error) throw insert.error;

    return json({ ...insert.data, cached: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("site-summary failed", message);
    return json({ error: "generation_failed", message }, 502);
  }
});

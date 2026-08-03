// Timesheet parser — pure, no I/O, no clock access.
//
// Supervisors send one free-text message per team per day, e.g.
//
//   12/08 Team 3 Jurong
//   (101 - 8)
//   (102 - 8.5)
//   103 - MC
//   105-8
//
// Everything here is deliberately side-effect free so it can be unit tested
// without a network or a database. The caller resolves "today" in the
// configured timezone and passes it in.

export type EntryRole = "worker" | "driver" | "welder" | "supervisor";

export interface ParsedEntry {
  workerCode: string;
  hours: number | null;
  absenceReason: string | null;
  role: EntryRole;
}

export interface ParsedTimesheet {
  workDate: string | null;
  teamNumber: string | null;
  location: string | null;
  entries: ParsedEntry[];
  unparsed: string[];
}

/** `101 - 8`, `(102 – 8.5)`, `105-8`, `A1: MC` */
const ENTRY_RE = /^([A-Za-z0-9][A-Za-z0-9._/-]{0,19}?)\s*[-–—:]\s*(.+)$/;
const ISO_DATE_RE = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/;
const DMY_DATE_RE = /\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/;
const RELATIVE_DATE_RE = /\b(today|yesterday)\b/i;
const TEAM_WORD_RE = /\bteam\s*([a-z0-9]+)\b/i;
const TEAM_SHORT_RE = /\bT\s?(\d+)\b/;
const ROLE_WORD_RE = /\b(driver|welder|supervisor|foreman)\b/i;
const ROLE_WORD_ALL_RE = /\b(driver|welder|supervisor|foreman)\b/ig;
const HOURS_RE = /^(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:h|hr|hrs|hour|hours)?\.?$/i;
/** "8am-5pm", "8 am to 5 pm", "0800-1700", "8-5" — a worked shift, not an absence. */
const TIME_RANGE_RE =
  /^\d{1,4}(?::\d{2})?\s*(?:am|pm)?\s*(?:-|–|—|to)\s*\d{1,4}(?::\d{2})?\s*(?:am|pm)?$/i;

const MAX_REASON = 60;
const MAX_LOCATION = 80;
const DAY_MS = 86_400_000;
/** A bare DD/MM is never read as more than ~6 months ahead of today. */
const FUTURE_WINDOW_DAYS = 183;

// ---------------------------------------------------------------- dates

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** null unless y-m-d is a real calendar date. */
function isoDate(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return `${y}-${pad(m)}-${pad(d)}`;
}

function dayNumber(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`) / DAY_MS;
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * A day/month with no year belongs to whichever year lands nearest to `today`,
 * never more than ~6 months in the future (a crew reporting "31/12" on 2 Jan
 * means last year, not next year).
 */
function yearForDayMonth(day: number, month: number, today: string): string | null {
  const thisYear = Number(today.slice(0, 4));
  const todayNum = dayNumber(today);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const year of [thisYear - 1, thisYear, thisYear + 1]) {
    const candidate = isoDate(year, month, day);
    if (!candidate) continue;
    const delta = dayNumber(candidate) - todayNum;
    // hard-reject the far future, then prefer the closest remaining candidate
    const score = delta > FUTURE_WINDOW_DAYS ? Number.POSITIVE_INFINITY : Math.abs(delta);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

interface DateHit {
  date: string;
  matched: string;
}

/** First date-like token anywhere in the line, day-first (Singapore). */
function findDate(line: string, today: string): DateHit | null {
  const iso = ISO_DATE_RE.exec(line);
  if (iso) {
    const date = isoDate(+iso[1], +iso[2], +iso[3]);
    if (date) return { date, matched: iso[0] };
  }

  const dmy = DMY_DATE_RE.exec(line);
  if (dmy) {
    const day = +dmy[1];
    const month = +dmy[2];
    if (dmy[3] === undefined) {
      const date = yearForDayMonth(day, month, today);
      if (date) return { date, matched: dmy[0] };
    } else {
      const raw = +dmy[3];
      const year = dmy[3].length <= 2 ? 2000 + raw : raw;
      const date = isoDate(year, month, day);
      if (date) return { date, matched: dmy[0] };
    }
  }

  const rel = RELATIVE_DATE_RE.exec(line);
  if (rel) {
    const back = rel[1].toLowerCase() === "yesterday" ? 1 : 0;
    return { date: shiftDays(today, -back), matched: rel[0] };
  }

  return null;
}

// ---------------------------------------------------------------- lines

function stripWrappers(line: string): string {
  let s = line.trim();
  s = s.replace(/^[([{]\s*/, "").replace(/\s*[)\]}]$/, "");
  s = s.replace(/^[-•*–—\s]+/, "");
  return s.trim();
}

/** Cheap shape test used by the auto-detect path and by the parser itself. */
export function isEntryLine(line: string): boolean {
  return ENTRY_RE.test(stripWrappers(line));
}

function splitLines(text: string): string[] {
  return text
    .split(/[\r\n;]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * True when a plain text message should be treated as a timesheet:
 * at least two lines, at least two of which look like entries.
 */
export function looksLikeTimesheet(text: string): boolean {
  const lines = splitLines(text);
  if (lines.length < 2) return false;
  return lines.filter(isEntryLine).length >= 2;
}

function roleOf(line: string): EntryRole {
  const hit = ROLE_WORD_RE.exec(line);
  if (!hit) return "worker";
  const word = hit[1].toLowerCase();
  if (word === "driver") return "driver";
  if (word === "welder") return "welder";
  return "supervisor";
}

function cleanValue(value: string): string {
  return value
    .replace(ROLE_WORD_ALL_RE, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.:;/-]+|[\s,.:;/-]+$/g, "")
    .trim();
}

// ---------------------------------------------------------------- parser

export function parseTimesheet(text: string, today: string, tz: string): ParsedTimesheet {
  void tz; // reserved: the caller already resolved `today` in this timezone

  const result: ParsedTimesheet = {
    workDate: null,
    teamNumber: null,
    location: null,
    entries: [],
    unparsed: [],
  };

  // insertion-ordered so re-sends of the same code overwrite in place
  const byCode = new Map<string, ParsedEntry>();
  const lines = splitLines(text ?? "");

  for (const raw of lines) {
    const line = stripWrappers(raw);
    const headerHit = readHeader(line, today, result, byCode.size === 0);
    if (headerHit === "header") continue;

    const match = ENTRY_RE.exec(line);
    if (!match) {
      result.unparsed.push(raw);
      continue;
    }

    const entry = readEntry(match[1], match[2], line);
    if (!entry) {
      result.unparsed.push(raw);
      continue;
    }
    byCode.set(entry.workerCode, entry);
  }

  result.entries = [...byCode.values()];
  return result;
}

/**
 * Header lines carry the date / team / location. They are recognised either by
 * having no entry separator at all, or — for the very first line, where
 * "12-08 Team 3" would otherwise look like `code - value` — by carrying a date
 * or team token.
 */
function readHeader(
  line: string,
  today: string,
  result: ParsedTimesheet,
  beforeAnyEntry: boolean,
): "header" | null {
  const looksLikeEntry = ENTRY_RE.test(line);
  const date = findDate(line, today);
  const team = TEAM_WORD_RE.exec(line) ?? TEAM_SHORT_RE.exec(line);

  if (looksLikeEntry && !(beforeAnyEntry && (date || team))) return null;
  if (!looksLikeEntry && !date && !team && !beforeAnyEntry) return null;
  if (!looksLikeEntry && !date && !team && beforeAnyEntry && result.location !== null) {
    return null;
  }

  if (date && result.workDate === null) result.workDate = date.date;
  if (team && result.teamNumber === null) result.teamNumber = team[1];

  let rest = line;
  if (date) rest = rest.replace(date.matched, " ");
  if (team) rest = rest.replace(team[0], " ");
  rest = rest
    .replace(/\s+/g, " ")
    .replace(/^[\s,.:;|·/-]+|[\s,.:;|·/-]+$/g, "")
    .trim();

  if (rest && result.location === null) result.location = rest.slice(0, MAX_LOCATION);
  return "header";
}

function readEntry(codeRaw: string, valueRaw: string, line: string): ParsedEntry | null {
  const workerCode = codeRaw.trim().toUpperCase();
  if (!workerCode) return null;

  const role = roleOf(line);
  const value = valueRaw.trim();
  const cleaned = cleanValue(value);

  const hoursMatch = HOURS_RE.exec(cleaned);
  if (hoursMatch) {
    const hours = Math.round(Number(hoursMatch[1].replace(",", ".")) * 10) / 10;
    // out-of-range hours are a typo, not a fact — surface the line instead
    if (!Number.isFinite(hours) || hours < 0 || hours > 24) return null;
    return { workerCode, hours, absenceReason: null, role };
  }

  // A shift written as a time range ("8am-5pm", "0800-1700") is the opposite of
  // an absence. Converting it to hours would mean guessing the break policy, and
  // storing it as a reason would mark a full day's work as a no-show — so surface
  // the line and let the supervisor restate it.
  if (TIME_RANGE_RE.test(cleaned || value)) return null;

  // role words already consumed the whole value ("101 - driver") → keep the raw
  // text so the XOR constraint still has something to store
  const reason = (cleaned || value).slice(0, MAX_REASON).trim();
  if (!reason) return null;
  return { workerCode, hours: null, absenceReason: reason, role };
}

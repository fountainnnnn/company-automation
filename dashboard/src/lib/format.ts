import { formatDistanceToNowStrict, isValid, parseISO } from "date-fns";

/** Every display and day-boundary calculation in the app runs in this zone. */
export const APP_TZ = "Asia/Singapore";

function safeDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = parseISO(value);
  return isValid(d) ? d : null;
}

/** A `date` column pinned to its own SGT day, so no zone can shift it. */
function dayDate(dateOnly: string): Date | null {
  if (!dateOnly) return null;
  const d = new Date(`${dateOnly}T00:00:00+08:00`);
  return isValid(d) ? d : null;
}

const dayFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_TZ,
  day: "numeric",
  month: "long",
  year: "numeric",
});

const weekdayFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_TZ,
  weekday: "long",
});

const timeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_TZ,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const dateTimeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_TZ,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** yyyy-MM-dd — ISO ordering, which is what en-CA gives us. */
const isoDayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "12 March 2026" from a `date` column. */
export function formatDay(dateOnly: string): string {
  const d = dayDate(dateOnly);
  return d ? dayFmt.format(d) : dateOnly;
}

/** "Thursday" — used in date group headers alongside the full date. */
export function formatWeekday(dateOnly: string): string {
  const d = dayDate(dateOnly);
  return d ? weekdayFmt.format(d) : "";
}

/** "14:32" from a timestamptz, in Singapore time. */
export function formatTime(ts: string | null): string {
  const d = safeDate(ts);
  return d ? timeFmt.format(d) : "—";
}

/** "12 Mar 2026, 14:32" from a timestamptz, in Singapore time. */
export function formatDateTime(ts: string | null): string {
  const d = safeDate(ts);
  return d ? dateTimeFmt.format(d) : "—";
}

/** The Singapore calendar day a timestamptz falls on, as yyyy-MM-dd. */
export function toSgtDay(ts: string | Date | null): string {
  const d = typeof ts === "string" ? safeDate(ts) : ts;
  return d ? isoDayFmt.format(d) : "";
}

/** "3 days ago" / "just now". */
export function formatRelative(ts: string | null): string {
  const d = safeDate(ts);
  if (!d) return "no activity yet";
  const seconds = (Date.now() - d.getTime()) / 1000;
  if (seconds < 60) return "just now";
  return `${formatDistanceToNowStrict(d)} ago`;
}

/** yyyy-MM-dd (Singapore day) for <input type="date"> values. */
export function toDateInput(d: Date): string {
  return isoDayFmt.format(d);
}

/** The SGT day window [start, end) for a yyyy-MM-dd, as ISO strings. */
export function sgtDayRange(day: string): { start: string; end: string } {
  const start = new Date(`${day}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** "9h 23m" between two timestamps. */
export function formatDuration(fromTs: string, toTs: string): string {
  const a = safeDate(fromTs);
  const b = safeDate(toTs);
  if (!a || !b) return "—";
  const mins = Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** "14.2 km apart" / "820 m apart". */
export function formatDistance(meters: number | null): string {
  if (meters === null || meters === undefined) return "distance unknown";
  return meters >= 1000
    ? `${(meters / 1000).toFixed(1)} km apart`
    : `${Math.round(meters)} m apart`;
}

export function formatFileSize(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileNameOf(storagePath: string): string {
  const parts = storagePath.split("/");
  return parts[parts.length - 1] || storagePath;
}

export function mapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

import { format, formatDistanceToNowStrict, isValid, parseISO } from "date-fns";

function safeDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = parseISO(value);
  return isValid(d) ? d : null;
}

/** "12 March 2026" from a `date` column (no timezone shifting). */
export function formatDay(dateOnly: string): string {
  const d = safeDate(dateOnly);
  return d ? format(d, "d MMMM yyyy") : dateOnly;
}

/** "Thu · 12 Mar" — used in date group headers alongside the full date. */
export function formatWeekday(dateOnly: string): string {
  const d = safeDate(dateOnly);
  return d ? format(d, "EEEE") : "";
}

/** "14:32" from a timestamptz. */
export function formatTime(ts: string | null): string {
  const d = safeDate(ts);
  return d ? format(d, "HH:mm") : "—";
}

/** "12 Mar 2026, 14:32" from a timestamptz. */
export function formatDateTime(ts: string | null): string {
  const d = safeDate(ts);
  return d ? format(d, "d MMM yyyy, HH:mm") : "—";
}

/** "3 days ago" / "just now". */
export function formatRelative(ts: string | null): string {
  const d = safeDate(ts);
  if (!d) return "no activity yet";
  const seconds = (Date.now() - d.getTime()) / 1000;
  if (seconds < 60) return "just now";
  return `${formatDistanceToNowStrict(d)} ago`;
}

/** yyyy-MM-dd for <input type="date"> values. */
export function toDateInput(d: Date): string {
  return format(d, "yyyy-MM-dd");
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

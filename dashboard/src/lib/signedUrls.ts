import { MEDIA_BUCKET, supabase } from "./supabase";

const TTL_SECONDS = 3600;
/** Refresh a little before the server-side expiry so a slow render never 403s. */
const SAFETY_MS = 5 * 60 * 1000;

interface Entry {
  url: string;
  expiresAt: number;
}

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<void>>();

function fresh(path: string): string | null {
  const hit = cache.get(path);
  if (hit && hit.expiresAt > Date.now()) return hit.url;
  if (hit) cache.delete(path);
  return null;
}

async function signBatch(paths: string[]): Promise<void> {
  const { data, error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .createSignedUrls(paths, TTL_SECONDS);
  if (error || !data) return;
  const expiresAt = Date.now() + TTL_SECONDS * 1000 - SAFETY_MS;
  for (const item of data) {
    if (item.signedUrl && item.path) cache.set(item.path, { url: item.signedUrl, expiresAt });
  }
}

/**
 * Signs every uncached path in one (chunked) batch call and returns a
 * path -> url map. Cached entries never hit the network again.
 */
export async function getSignedUrls(paths: string[]): Promise<Record<string, string>> {
  const unique = Array.from(new Set(paths));
  const missing = unique.filter((p) => !fresh(p) && !inFlight.has(p));

  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const job = signBatch(chunk).finally(() => {
      for (const p of chunk) inFlight.delete(p);
    });
    for (const p of chunk) inFlight.set(p, job);
  }

  await Promise.all(unique.map((p) => inFlight.get(p)).filter(Boolean));

  const out: Record<string, string> = {};
  for (const p of unique) {
    const url = fresh(p);
    if (url) out[p] = url;
  }
  return out;
}

export async function getSignedUrl(path: string): Promise<string | null> {
  const map = await getSignedUrls([path]);
  return map[path] ?? null;
}

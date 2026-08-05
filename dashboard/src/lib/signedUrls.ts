import { MEDIA_BUCKET, supabase } from "./supabase";

const TTL_SECONDS = 3600;
/** Refresh a little before the server-side expiry so a slow render never 403s. */
const SAFETY_MS = 5 * 60 * 1000;

/**
 * Thumbnail size, in CSS pixels of the largest grid cell, doubled for retina.
 * Supabase (Pro) resizes on the fly, so a 1280px site photo arrives as ~7 kB
 * instead of ~50 kB — a 30-photo day goes from ~1.5 MB to ~200 kB. The
 * lightbox and downloads still get the untouched original.
 */
export const THUMB = { width: 400, height: 400, resize: "cover", quality: 65 } as const;

interface Entry {
  url: string;
  expiresAt: number;
}

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<void>>();

/** Cache key: the same object at two sizes is two different URLs. */
const keyFor = (path: string, thumb: boolean) => (thumb ? `t:${path}` : path);

function fresh(key: string): string | null {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.url;
  if (hit) cache.delete(key);
  return null;
}

async function signBatch(paths: string[], thumb: boolean): Promise<void> {
  const expiresAt = Date.now() + TTL_SECONDS * 1000 - SAFETY_MS;

  // Resizing has to be baked into the token — the batch endpoint silently
  // ignores `transform` and hands back full-size URLs. So thumbnails are signed
  // one at a time (in parallel); the requests are tiny and each path is only
  // signed once an hour, which is a fair trade for ~85% less image payload.
  if (thumb) {
    await Promise.all(
      paths.map(async (path) => {
        const { data } = await supabase.storage
          .from(MEDIA_BUCKET)
          .createSignedUrl(path, TTL_SECONDS, { transform: THUMB });
        if (data?.signedUrl) cache.set(keyFor(path, true), { url: data.signedUrl, expiresAt });
      }),
    );
    return;
  }

  const { data, error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .createSignedUrls(paths, TTL_SECONDS);
  if (error || !data) return;
  for (const item of data) {
    if (item.signedUrl && item.path) {
      cache.set(keyFor(item.path, false), { url: item.signedUrl, expiresAt });
    }
  }
}

/**
 * Signs every uncached path in one (chunked) batch call and returns a
 * path -> url map. Cached entries never hit the network again.
 *
 * `thumb` asks the storage layer for a resized copy — use it for grids and
 * covers, never for the lightbox or a download.
 */
export async function getSignedUrls(
  paths: string[],
  thumb = false,
): Promise<Record<string, string>> {
  const unique = Array.from(new Set(paths));
  const missing = unique.filter((p) => !fresh(keyFor(p, thumb)) && !inFlight.has(keyFor(p, thumb)));

  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const job = signBatch(chunk, thumb).finally(() => {
      for (const p of chunk) inFlight.delete(keyFor(p, thumb));
    });
    for (const p of chunk) inFlight.set(keyFor(p, thumb), job);
  }

  await Promise.all(unique.map((p) => inFlight.get(keyFor(p, thumb))).filter(Boolean));

  const out: Record<string, string> = {};
  for (const p of unique) {
    const url = fresh(keyFor(p, thumb));
    if (url) out[p] = url;
  }
  return out;
}

// plugins/bounty/feedcache.mjs — polite on-disk cache for the public feed.
//
// The HackerOne scope feed is ~18 MB and changes slowly. Politeness, in order:
//   1. TTL — while a snapshot is younger than cacheTtlMs, use it and make NO request.
//   2. Conditional GET — once stale, send If-None-Match; a 304 costs no download.
//   3. Stale-if-error — on a block/5xx, reuse the last good snapshot rather than losing the run.
// Cache lives under .loam (gitignored, runtime). Opt-in: no cacheDir → no caching
// (unit tests inject their own fetch and are unaffected).
import fs from 'node:fs';
import path from 'node:path';

const bodyPath = (dir, id) => path.join(dir, `${id}.body.json`);
const metaPath = (dir, id) => path.join(dir, `${id}.meta.json`);

export function readCache(dir, id, now, ttlMs) {
  try {
    const mp = metaPath(dir, id), bp = bodyPath(dir, id);
    if (!fs.existsSync(mp) || !fs.existsSync(bp)) return null;
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const body = fs.readFileSync(bp, 'utf8');
    const fresh = ttlMs > 0 && now - (meta.fetchedAt ?? 0) < ttlMs;
    return { body, etag: meta.etag ?? null, fetchedAt: meta.fetchedAt ?? 0, fresh };
  } catch { return null; }
}

export function writeCache(dir, id, body, etag, now) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `${id}.body.${process.pid}.tmp`);
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, bodyPath(dir, id));                 // atomic replace of the body
    fs.writeFileSync(metaPath(dir, id), JSON.stringify({ etag: etag ?? null, fetchedAt: now, bytes: Buffer.byteLength(body) }));
  } catch { /* cache is best-effort; a failure just means we fetch next time */ }
}

export function touchCache(dir, id, now) {
  try {
    const mp = metaPath(dir, id);
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
    meta.fetchedAt = now;
    fs.writeFileSync(mp, JSON.stringify(meta));
  } catch { /* best-effort */ }
}

/**
 * Fetch a feed politely. `fetchText(url, headers)` must resolve to
 * { ok, status, text, headers, blocked }. Returns { body, source } where source
 * is 'cache-fresh' | 'revalidated-304' | 'fetched' | 'stale-if-error', or null.
 */
export async function fetchFeedCached(fetchText, { dir, id, url, now, ttlMs }) {
  if (!dir) { const r = await fetchText(url, { accept: 'application/json' }); return r.ok ? { body: r.text, source: 'fetched' } : { body: null, source: 'error', blocked: r.blocked, status: r.status }; }
  const cached = readCache(dir, id, now, ttlMs);
  if (cached?.fresh) return { body: cached.body, source: 'cache-fresh' };
  const headers = { accept: 'application/json' };
  if (cached?.etag) headers['if-none-match'] = cached.etag;
  const r = await fetchText(url, headers);
  if (r.status === 304 && cached) { touchCache(dir, id, now); return { body: cached.body, source: 'revalidated-304' }; }
  if (r.ok) { writeCache(dir, id, r.text, r.headers?.etag ?? null, now); return { body: r.text, source: 'fetched' }; }
  if (cached) return { body: cached.body, source: 'stale-if-error', blocked: r.blocked, status: r.status };
  return { body: null, source: 'error', blocked: r.blocked, status: r.status };
}

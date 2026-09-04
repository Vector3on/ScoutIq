// core/sync.mjs — anti-entropy between a local replica and a hub, plus the
// git-ledger backend (JSONL segments per node, merged by union).
//
// Star topology: every node pulls the hub's new events by the hub's ingest
// cursor and pushes its own (origin = 'local') events by its local cursor.
// Because the event set is a G-Set and projections are pure folds over the
// HLC-sorted set, every replica converges once it has seen every event, in
// any arrival order (tests/sync.test.mjs asserts this property directly).
import fs from 'node:fs';
import path from 'node:path';
import { shortHash } from './events.mjs';

export function hubId(store) {
  return `hub:${shortHash(store.label).slice(0, 12)}`;
}

/** Pull new hub events into the local replica. */
export async function pull(local, hub, { clock = null, batch = 500, log = () => {} } = {}) {
  const id = hubId(hub);
  const key = `sync.pull.${id}`;
  let cursor = Number((await local.getMeta(key)) ?? 0);
  let total = 0;
  for (;;) {
    const rows = await hub.readSince(cursor, batch);
    if (!rows.length) break;
    const events = rows.map(({ ingestSeq, origin, ...ev }) => ev);
    const r = await local.append(events, { origin: id });
    total += r.appended;
    if (clock) for (const ev of events) clock.observe(ev.hlc);
    cursor = rows[rows.length - 1].ingestSeq;
    await local.setMeta(key, cursor);
    log(`pull ${id}: +${r.appended} (cursor ${cursor})`);
    if (rows.length < batch) break;
  }
  return { pulled: total, cursor };
}

/** Push local-origin events not yet pushed to the hub. */
export async function push(local, hub, { batch = 200, log = () => {} } = {}) {
  const id = hubId(hub);
  const key = `sync.push.${id}`;
  let cursor = Number((await local.getMeta(key)) ?? 0);
  let total = 0;
  for (;;) {
    const rows = await local.readSince(cursor, batch, { origin: 'local' });
    if (!rows.length) break;
    const events = rows.map(({ ingestSeq, origin, ...ev }) => ev);
    const r = await hub.append(events, { origin: 'remote' });
    total += r.appended;
    cursor = rows[rows.length - 1].ingestSeq;
    await local.setMeta(key, cursor);
    log(`push ${id}: +${r.appended} (cursor ${cursor})`);
    if (rows.length < batch) break;
  }
  return { pushed: total, cursor };
}

export async function sync(local, hub, opts = {}) {
  const a = await pull(local, hub, opts);
  const b = await push(local, hub, opts);
  return { ...a, ...b };
}

// ---------------------------------------------------------------------------
// Git ledger: JSONL segments, one file per node, append-only. Zero secrets.
// ---------------------------------------------------------------------------
const MAX_SEGMENT_BYTES = 4 * 1024 * 1024;

export async function exportLedger(local, dir, { batch = 1000 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const key = 'ledger.export.cursor';
  let cursor = Number((await local.getMeta(key)) ?? 0);
  let written = 0;
  for (;;) {
    const rows = await local.readSince(cursor, batch, { origin: 'local' });
    if (!rows.length) break;
    const byNode = new Map();
    for (const { ingestSeq, origin, ...ev } of rows) {
      if (!byNode.has(ev.node)) byNode.set(ev.node, []);
      byNode.get(ev.node).push(JSON.stringify(ev));
    }
    for (const [node, lines] of byNode) {
      const file = currentSegment(dir, node);
      fs.appendFileSync(file, lines.join('\n') + '\n');
      written += lines.length;
    }
    cursor = rows[rows.length - 1].ingestSeq;
    await local.setMeta(key, cursor);
    if (rows.length < batch) break;
  }
  return { written, cursor };
}

function currentSegment(dir, node) {
  const safe = node.replace(/[^a-zA-Z0-9._-]/g, '_');
  let n = 0;
  for (;;) {
    const f = path.join(dir, n === 0 ? `${safe}.jsonl` : `${safe}.${n}.jsonl`);
    if (!fs.existsSync(f) || fs.statSync(f).size < MAX_SEGMENT_BYTES) return f;
    n++;
  }
}

export async function importLedger(local, dir) {
  if (!fs.existsSync(dir)) return { imported: 0, files: 0 };
  let imported = 0, files = 0;
  const names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  for (const name of names) {
    files++;
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const events = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      events.push(JSON.parse(line));
    }
    // Chunk to keep transactions small.
    for (let i = 0; i < events.length; i += 1000) {
      const r = await local.append(events.slice(i, i + 1000), { origin: 'ledger' });
      imported += r.appended;
    }
  }
  return { imported, files };
}

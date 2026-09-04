// core/store.mjs — append-only event stores.
//
// The log is the source of truth and is a grow-only set under union (G-Set):
//   * events are content-addressed (id = hash of canonical event), so
//     INSERT OR IGNORE by id makes every write idempotent;
//   * (node, seq) is unique, so a node can never fork its own history;
//   * ingest_seq is a per-store monotone cursor (not part of event identity),
//     used by sync and snapshots; it differs between stores and that's fine.
//
// Two backends share one schema:
//   LocalStore  — node:sqlite (file or ':memory:'), used on every worker.
//   TursoStore  — Turso/libSQL over the Hrana HTTP pipeline, zero deps,
//                 used as the shared hub (the "pheromone field").
import fs from 'node:fs';
import path from 'node:path';
import { makeEvent } from './events.mjs';

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
     ingest_seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     node TEXT NOT NULL,
     seq INTEGER NOT NULL,
     hlc TEXT NOT NULL,
     kind TEXT NOT NULL,
     domain TEXT,
     ts INTEGER NOT NULL,
     dedup_key TEXT,
     body TEXT NOT NULL,
     origin TEXT NOT NULL DEFAULT 'local',
     UNIQUE(node, seq)
   )`,
  `CREATE INDEX IF NOT EXISTS events_hlc ON events(hlc)`,
  `CREATE INDEX IF NOT EXISTS events_kind ON events(kind)`,
  `CREATE INDEX IF NOT EXISTS events_dedup ON events(dedup_key)`,
  `CREATE INDEX IF NOT EXISTS events_domain ON events(domain)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS snapshots (
     name TEXT PRIMARY KEY, version INTEGER NOT NULL, watermark TEXT NOT NULL,
     ingest_seq INTEGER NOT NULL, state TEXT NOT NULL, built_at INTEGER NOT NULL
   )`,
];

const COLS = 'ingest_seq, id, node, seq, hlc, kind, domain, ts, dedup_key, body, origin';

function rowToEvent(r) {
  return {
    ingestSeq: Number(r.ingest_seq),
    id: r.id,
    node: r.node,
    seq: Number(r.seq),
    hlc: r.hlc,
    kind: r.kind,
    domain: r.domain ?? null,
    ts: Number(r.ts),
    dedupKey: r.dedup_key ?? null,
    body: typeof r.body === 'string' ? JSON.parse(r.body) : r.body,
    origin: r.origin ?? 'local',
  };
}

/** Assert an event was sanitized by the policy layer before it is stored. */
function assertStorable(ev) {
  if (!ev || typeof ev !== 'object') throw new TypeError('append: event required');
  if (!ev.id || !ev.node || !ev.hlc || !ev.kind) throw new TypeError('append: malformed event');
  // Recompute the id to make sure nobody tampered with an event after creation.
  const check = makeEvent({ node: ev.node, seq: ev.seq, hlc: ev.hlc, kind: ev.kind, ts: ev.ts, body: ev.body, dedupKey: ev.dedupKey ?? null, domain: ev.domain ?? null });
  if (check.id !== ev.id) throw new TypeError(`append: event id mismatch for ${ev.id} (tampered or built outside makeEvent)`);
}

// ---------------------------------------------------------------------------
// LocalStore
// ---------------------------------------------------------------------------
export class LocalStore {
  constructor(file = ':memory:') {
    const sqlite = process.getBuiltinModule('node:sqlite');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.file = file;
    this.db = new sqlite.DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    for (const s of SCHEMA) this.db.exec(s);
    this._ins = this.db.prepare(
      `INSERT OR IGNORE INTO events (id, node, seq, hlc, kind, domain, ts, dedup_key, body, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this._hasDedup = this.db.prepare(`SELECT 1 FROM events WHERE dedup_key = ? LIMIT 1`);
    this._since = this.db.prepare(`SELECT ${COLS} FROM events WHERE ingest_seq > ? ORDER BY ingest_seq LIMIT ?`);
    this._sinceOrigin = this.db.prepare(`SELECT ${COLS} FROM events WHERE ingest_seq > ? AND origin = ? ORDER BY ingest_seq LIMIT ?`);
    this._getMeta = this.db.prepare(`SELECT value FROM meta WHERE key = ?`);
    this._setMeta = this.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    this._maxSeq = this.db.prepare(`SELECT MAX(seq) AS m FROM events WHERE node = ?`);
  }
  get kind() { return 'local'; }
  get label() { return `local:${this.file}`; }

  async init() { return this; }

  /**
   * Append events. Options:
   *   origin — 'local' | '<hub id>' | 'ledger' (provenance for push filtering)
   *   skipIfDedupKeyExists — local optimisation: don't re-append content this
   *     store has already seen (safe: the existing event carries the content).
   */
  async append(events, { origin = 'local', skipIfDedupKeyExists = false } = {}) {
    let appended = 0, skipped = 0;
    this.db.exec('BEGIN');
    try {
      for (const ev of events) {
        assertStorable(ev);
        if (skipIfDedupKeyExists && ev.dedupKey && this._hasDedup.get(ev.dedupKey)) { skipped++; continue; }
        const r = this._ins.run(ev.id, ev.node, ev.seq, ev.hlc, ev.kind, ev.domain ?? null, ev.ts, ev.dedupKey ?? null, JSON.stringify(ev.body), origin);
        if (r.changes > 0) appended++; else skipped++;
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { appended, skipped };
  }

  async readSince(ingestSeq = 0, limit = 1000, { origin = null } = {}) {
    const rows = origin ? this._sinceOrigin.all(ingestSeq, origin, limit) : this._since.all(ingestSeq, limit);
    return rows.map(rowToEvent);
  }

  async readAll({ domain = null, kinds = null } = {}) {
    let sql = `SELECT ${COLS} FROM events`;
    const where = [], args = [];
    if (domain) { where.push('(domain = ? OR domain IS NULL)'); args.push(domain); }
    if (kinds && kinds.length) { where.push(`kind IN (${kinds.map(() => '?').join(',')})`); args.push(...kinds); }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY hlc';
    return this.db.prepare(sql).all(...args).map(rowToEvent);
  }

  async count() { return Number(this.db.prepare('SELECT COUNT(*) AS c FROM events').get().c); }
  async maxIngestSeq() { return Number(this.db.prepare('SELECT COALESCE(MAX(ingest_seq), 0) AS m FROM events').get().m); }
  async maxSeqForNode(node) { return Number(this._maxSeq.get(node).m ?? 0); }
  async hasDedupKey(key) { return !!this._hasDedup.get(key); }
  async getMeta(key) { const r = this._getMeta.get(key); return r ? r.value : null; }
  async setMeta(key, value) { this._setMeta.run(key, String(value)); }

  async getSnapshot(name) {
    const r = this.db.prepare('SELECT * FROM snapshots WHERE name = ?').get(name);
    if (!r) return null;
    return { name: r.name, version: Number(r.version), watermark: r.watermark, ingestSeq: Number(r.ingest_seq), state: JSON.parse(r.state), builtAt: Number(r.built_at) };
  }
  async putSnapshot({ name, version, watermark, ingestSeq, state, builtAt }) {
    this.db.prepare(
      `INSERT INTO snapshots (name, version, watermark, ingest_seq, state, built_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET version = excluded.version, watermark = excluded.watermark, ingest_seq = excluded.ingest_seq, state = excluded.state, built_at = excluded.built_at`,
    ).run(name, version, watermark, ingestSeq, JSON.stringify(state), builtAt);
  }
  async close() { this.db.close(); }
}

// ---------------------------------------------------------------------------
// TursoStore — Hrana over HTTP (`/v2/pipeline`). No client library needed.
// ---------------------------------------------------------------------------
export class TursoStore {
  constructor(url, token, { fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
    if (!url) throw new TypeError('TursoStore: url required');
    this.baseUrl = url.replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
    this.token = token || null;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.requests = 0;
  }
  get kind() { return 'turso'; }
  get label() { return `turso:${new URL(this.baseUrl).host}`; }

  async init() {
    await this.batch(SCHEMA.map((sql) => ({ sql })));
    return this;
  }

  toArg(v) {
    if (v === null || v === undefined) return { type: 'null' };
    if (typeof v === 'number') return Number.isInteger(v) && Number.isSafeInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
    if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
    if (v instanceof Uint8Array) return { type: 'blob', base64: Buffer.from(v).toString('base64') };
    return { type: 'text', value: String(v) };
  }
  fromCell(c) {
    if (!c || c.type === 'null') return null;
    if (c.type === 'integer') return Number(c.value);
    if (c.type === 'float') return Number(c.value);
    if (c.type === 'blob') return Buffer.from(c.base64, 'base64');
    return c.value;
  }

  /** Run statements sequentially on one connection; returns row objects per statement. */
  async batch(stmts) {
    const requests = stmts.map(({ sql, args = [] }) => ({ type: 'execute', stmt: { sql, args: args.map((a) => this.toArg(a)) } }));
    requests.push({ type: 'close' });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      this.requests++;
      res = await this.fetch(`${this.baseUrl}/v2/pipeline`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify({ requests }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`Turso HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    const out = [];
    for (let i = 0; i < stmts.length; i++) {
      const r = json.results[i];
      if (!r || r.type !== 'ok') throw new Error(`Turso statement ${i} failed: ${r?.error?.message ?? 'unknown'} :: ${stmts[i].sql.slice(0, 80)}`);
      const result = r.response.result;
      const cols = result.cols.map((c) => c.name);
      out.push({
        rows: result.rows.map((row) => Object.fromEntries(row.map((cell, j) => [cols[j], this.fromCell(cell)]))),
        affected: result.affected_row_count ?? 0,
      });
    }
    return out;
  }
  async execute(sql, args = []) { return (await this.batch([{ sql, args }]))[0]; }

  async append(events, { origin = 'local', chunk = 100 } = {}) {
    let appended = 0, skipped = 0;
    for (let i = 0; i < events.length; i += chunk) {
      const slice = events.slice(i, i + chunk);
      for (const ev of slice) assertStorable(ev);
      const stmts = [{ sql: 'BEGIN' }];
      for (const ev of slice) {
        stmts.push({
          sql: `INSERT OR IGNORE INTO events (id, node, seq, hlc, kind, domain, ts, dedup_key, body, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [ev.id, ev.node, ev.seq, ev.hlc, ev.kind, ev.domain ?? null, ev.ts, ev.dedupKey ?? null, JSON.stringify(ev.body), origin],
        });
      }
      stmts.push({ sql: 'COMMIT' });
      const results = await this.batch(stmts);
      for (let j = 1; j < results.length - 1; j++) {
        if (results[j].affected > 0) appended++; else skipped++;
      }
    }
    return { appended, skipped };
  }

  async readSince(ingestSeq = 0, limit = 500, { origin = null } = {}) {
    const sql = origin
      ? `SELECT ${COLS} FROM events WHERE ingest_seq > ? AND origin = ? ORDER BY ingest_seq LIMIT ?`
      : `SELECT ${COLS} FROM events WHERE ingest_seq > ? ORDER BY ingest_seq LIMIT ?`;
    const { rows } = await this.execute(sql, origin ? [ingestSeq, origin, limit] : [ingestSeq, limit]);
    return rows.map(rowToEvent);
  }
  async readAll() { throw new Error('TursoStore.readAll: use readSince pagination'); }
  async count() { return Number((await this.execute('SELECT COUNT(*) AS c FROM events')).rows[0].c); }
  async maxIngestSeq() { return Number((await this.execute('SELECT COALESCE(MAX(ingest_seq), 0) AS m FROM events')).rows[0].m); }
  async maxSeqForNode(node) { return Number((await this.execute('SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE node = ?', [node])).rows[0].m); }
  async hasDedupKey(key) { return (await this.execute('SELECT 1 AS x FROM events WHERE dedup_key = ? LIMIT 1', [key])).rows.length > 0; }
  async getMeta(key) { const r = (await this.execute('SELECT value FROM meta WHERE key = ?', [key])).rows[0]; return r ? r.value : null; }
  async setMeta(key, value) { await this.execute('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)]); }
  async getSnapshot() { return null; }
  async putSnapshot() { /* the hub keeps no snapshots; they are a per-node optimisation */ }
  async close() {}
}

/**
 * Open a store from a URL:
 *   ':memory:' | 'file:./x.db' | './x.db'     → LocalStore
 *   'libsql://...' | 'https://...turso.io'    → TursoStore (token required)
 */
export async function openStore(url, { token = null, fetchImpl } = {}) {
  if (!url || url === ':memory:') return new LocalStore(':memory:').init();
  if (/^(libsql|https?):\/\//.test(url)) return new TursoStore(url, token, { fetchImpl }).init();
  return new LocalStore(url.replace(/^file:/, '')).init();
}

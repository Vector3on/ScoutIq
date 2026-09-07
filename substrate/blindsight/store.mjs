import { LocalStore } from '../core/store.mjs';
import { Clock, makeEvent, newNodeId, shortHash } from '../core/events.mjs';
import { sanitize } from '../policy/data.mjs';

// Additive projections share Loam's event database. Dynamic properties are rows,
// not SQL identifiers; queries can pivot them through json_group_object.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS bs_runs(id TEXT PRIMARY KEY, target TEXT NOT NULL, started INTEGER NOT NULL, finished INTEGER, status TEXT NOT NULL, summary TEXT);
CREATE TABLE IF NOT EXISTS bs_artifacts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, path TEXT NOT NULL, digest TEXT NOT NULL, text TEXT NOT NULL, meta TEXT NOT NULL, UNIQUE(run_id,path));
CREATE INDEX IF NOT EXISTS bs_artifacts_run ON bs_artifacts(run_id);
CREATE TABLE IF NOT EXISTS bs_facts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, entity TEXT NOT NULL, layer TEXT NOT NULL, predicate TEXT NOT NULL, value TEXT NOT NULL, status TEXT NOT NULL, evidence TEXT NOT NULL, producer TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS bs_facts_run_layer ON bs_facts(run_id,layer);
CREATE TABLE IF NOT EXISTS bs_tasks(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, worker TEXT NOT NULL, payload TEXT NOT NULL, priority REAL NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, error TEXT);
CREATE INDEX IF NOT EXISTS bs_tasks_ready ON bs_tasks(run_id,state,priority);
CREATE TABLE IF NOT EXISTS bs_fields(layer TEXT NOT NULL, predicate TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY(layer,predicate,type));
CREATE VIEW IF NOT EXISTS bs_entity_attributes AS SELECT run_id,entity,json_group_object(predicate,json(values_json)) AS attributes FROM (SELECT run_id,entity,predicate,json_group_array(json(value)) AS values_json FROM bs_facts WHERE status='observed' GROUP BY run_id,entity,predicate) GROUP BY run_id,entity;
`;

export class AnatomyStore extends LocalStore {
  constructor(file = ':memory:') {
    super(file);
    this.db.exec('PRAGMA busy_timeout=5000');
    this.db.exec(SCHEMA);
    this.node = newNodeId('blindsight'); this.clock = new Clock(this.node); this.seq = 0;
  }
  async event(kind, body, key = null) {
    const cleaned = sanitize(body, { maxStringLength: 2097152 }).value;
    const ev = makeEvent({ node: this.node, seq: ++this.seq, hlc: this.clock.tick(), ts: Date.now(), kind, domain: 'blindsight', dedupKey: key, body: cleaned });
    await this.append([ev], { skipIfDedupKeyExists: !!key });
    return ev;
  }
  start(id, target) {
    this.db.prepare(`INSERT INTO bs_runs VALUES(?,?,?,NULL,'running',NULL) ON CONFLICT(id) DO UPDATE SET status='running', finished=NULL`).run(id, target, Date.now());
  }
  finish(id, status, summary) {
    this.db.prepare('UPDATE bs_runs SET status=?,finished=?,summary=? WHERE id=?').run(status, Date.now(), JSON.stringify(summary), id);
  }
  run(id) { return this.db.prepare('SELECT * FROM bs_runs WHERE id=?').get(id); }
  artifacts(id) { return this.db.prepare('SELECT * FROM bs_artifacts WHERE run_id=? ORDER BY path').all(id).map(r => ({ ...r, meta: JSON.parse(r.meta) })); }
  artifact(id) { const r = this.db.prepare('SELECT * FROM bs_artifacts WHERE id=?').get(id); return r && { ...r, meta: JSON.parse(r.meta) }; }
  putArtifact(runId, name, text, meta = {}) {
    const digest = shortHash(text), id = shortHash({ runId, name, digest });
    this.db.prepare('INSERT OR REPLACE INTO bs_artifacts VALUES(?,?,?,?,?,?)').run(id, runId, name, digest, text, JSON.stringify(meta));
    return this.artifact(id);
  }
  facts(id) { return this.db.prepare('SELECT * FROM bs_facts WHERE run_id=? ORDER BY layer,entity,predicate,id').all(id).map(r => ({ ...r, value: JSON.parse(r.value), evidence: JSON.parse(r.evidence) })); }
  putFact(runId, f) {
    const body = sanitize(f, { maxStringLength: 8000 }).value;
    if (!body.entity || !body.layer || !body.predicate || !['observed', 'inferred', 'unknown'].includes(body.status)) throw Error('Invalid fact');
    if (!Array.isArray(body.evidence) || (body.status !== 'unknown' && !body.evidence.length)) throw Error('Fact requires evidence');
    for (const e of body.evidence) {
      const a = this.artifact(e.artifact);
      if (!a || a.run_id !== runId || !Number.isInteger(e.start) || !Number.isInteger(e.end) || e.start < 1 || e.end < e.start || e.end > a.text.split('\n').length) throw Error('Evidence is outside the artifact');
    }
    const id = shortHash({ runId, ...body });
    const r = this.db.prepare('INSERT OR IGNORE INTO bs_facts VALUES(?,?,?,?,?,?,?,?,?)').run(id, runId, body.entity, body.layer, body.predicate, JSON.stringify(body.value), body.status, JSON.stringify(body.evidence), body.producer);
    const type = body.value === null ? 'null' : Array.isArray(body.value) ? 'array' : typeof body.value;
    this.db.prepare('INSERT OR IGNORE INTO bs_fields VALUES(?,?,?)').run(body.layer, body.predicate, type);
    return { added: Number(r.changes), fact: { id, run_id: runId, ...body } };
  }
  enqueue(runId, worker, payload, priority = 1) {
    const id = shortHash({ runId, worker, payload });
    return Number(this.db.prepare('INSERT OR IGNORE INTO bs_tasks(id,run_id,worker,payload,priority) VALUES(?,?,?,?,?)').run(id, runId, worker, JSON.stringify(payload), priority).changes);
  }
  claim(runId) {
    // Atomic claim works across processes. An interrupted worker becomes eligible
    // again after its lease, and completing a task is idempotent by stable IDs.
    const r = this.db.prepare(`UPDATE bs_tasks SET state='running',attempts=attempts+1,lease_until=? WHERE id=(SELECT id FROM bs_tasks WHERE run_id=? AND (state='pending' OR (state='running' AND lease_until<?)) ORDER BY priority DESC,id LIMIT 1) RETURNING *`).get(Date.now() + 60000, runId, Date.now());
    return r && { ...r, payload: JSON.parse(r.payload) };
  }
  complete(id, error = null) { this.db.prepare('UPDATE bs_tasks SET state=?,error=?,lease_until=NULL WHERE id=?').run(error ? 'failed' : 'done', error ? sanitize(String(error)).value : null, id); }
  defer(id) { this.db.prepare("UPDATE bs_tasks SET state='pending',lease_until=NULL WHERE id=?").run(id); }
  tasks(id) { return this.db.prepare('SELECT * FROM bs_tasks WHERE run_id=? ORDER BY priority DESC,id').all(id); }
}

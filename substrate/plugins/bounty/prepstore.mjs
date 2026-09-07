// plugins/bounty/prepstore.mjs — durable, resumable storage for investigation records.
//
// Two primitives, both crash-safe:
//   • an append-only JSONL journal — every record snapshot is one line; recovery is
//     a replay that keeps the last snapshot per lead. A half-written trailing line
//     is ignored, so an interrupted write never corrupts the store.
//   • atomic task claims — an exclusive-create claim file (O_CREAT|O_EXCL) with an
//     expiry. One worker holds a lead at a time; an expired claim can be stolen, so
//     a worker that dies mid-investigation does not strand the lead forever.
//
// This is what makes the prep loop resumable: kill it anywhere, start it again, and
// it continues from the journal without repeating finished work.
import fs from 'node:fs';
import path from 'node:path';

const safe = (s) => String(s).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180);

export class Prepstore {
  constructor(dir) {
    this.dir = dir;
    this.journalPath = path.join(dir, 'journal.jsonl');
    this.claimsDir = path.join(dir, 'claims');
    fs.mkdirSync(this.claimsDir, { recursive: true });
  }

  append(event) {
    fs.appendFileSync(this.journalPath, JSON.stringify(event) + '\n');   // one line; POSIX append is atomic for our small records
  }

  saveRecord(rec, at = Date.now()) {
    this.append({ ts: at, type: 'record', leadId: rec.leadId, state: rec.state, record: rec });
  }

  /** Replay the journal → { records: Map<leadId, record>, states: Map<leadId,state> }. Tolerates a torn last line. */
  load() {
    const records = new Map();
    if (!fs.existsSync(this.journalPath)) return { records };
    const lines = fs.readFileSync(this.journalPath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }          // torn/partial trailing line → skip
      if (ev.type === 'record' && ev.record) records.set(ev.leadId, ev.record);
    }
    return { records };
  }

  _claimPath(leadId) { return path.join(this.claimsDir, `${safe(leadId)}.claim`); }

  claimHolder(leadId, now = Date.now()) {
    try {
      const raw = fs.readFileSync(this._claimPath(leadId), 'utf8');
      const c = JSON.parse(raw);
      if (!c || typeof c.until !== 'number' || c.until <= now) return null;  // expired / invalid → free
      return c;
    } catch { return null; }
  }

  /** Atomic claim with expiry. Returns true if this node now holds the lead. */
  claim(leadId, node, ttlMs, now = Date.now()) {
    const p = this._claimPath(leadId);
    const payload = JSON.stringify({ node, until: now + ttlMs, at: now });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(p, 'wx');                                    // O_CREAT|O_EXCL — atomic
        try { fs.writeSync(fd, payload); } finally { fs.closeSync(fd); }
        this.append({ ts: now, type: 'claimed', leadId, node, until: now + ttlMs });
        return true;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const holder = this.claimHolder(leadId, now);
        if (holder && holder.node !== node) return false;                   // someone else holds an unexpired claim
        // free or expired (or ours) → remove and retry once to re-take atomically
        try { fs.unlinkSync(p); } catch { /* raced away */ }
      }
    }
    return false;
  }

  release(leadId, now = Date.now()) {
    try { fs.unlinkSync(this._claimPath(leadId)); } catch { /* already gone */ }
    this.append({ ts: now, type: 'released', leadId });
  }
}

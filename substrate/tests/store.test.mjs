import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../core/store.mjs';
import { makeEvent, Clock } from '../core/events.mjs';
import { exportLedger, importLedger } from '../core/sync.mjs';

function events(node, n, { t = 1000, dedup = null } = {}) {
  const c = new Clock(node, () => t);
  return Array.from({ length: n }, (_, i) => makeEvent({ node, seq: i + 1, hlc: c.tick(), kind: 'note.recorded', ts: t, body: { i, node }, dedupKey: dedup ? dedup(i) : null }));
}

test('append is idempotent by id and (node, seq); dedup keys skip locally', async () => {
  const s = await openStore(':memory:');
  const evs = events('a', 5);
  assert.deepEqual(await s.append(evs), { appended: 5, skipped: 0 });
  assert.deepEqual(await s.append(evs), { appended: 0, skipped: 5 });
  const dup = events('b', 1, { t: 2000, dedup: () => 'k1' });
  assert.deepEqual(await s.append(dup), { appended: 1, skipped: 0 });
  const dup2 = events('c', 1, { t: 3000, dedup: () => 'k1' });
  assert.deepEqual(await s.append(dup2, { skipIfDedupKeyExists: true }), { appended: 0, skipped: 1 });
  assert.equal(await s.count(), 6);
  assert.equal(await s.maxSeqForNode('a'), 5);
  assert.throws; // tampered event refused
  const bad = { ...evs[0], body: { i: 99 } };
  await assert.rejects(() => s.append([bad]), /id mismatch/);
});

test('readSince paginates by ingest cursor and filters by origin', async () => {
  const s = await openStore(':memory:');
  await s.append(events('a', 7));
  await s.append(events('b', 3), { origin: 'hub:x' });
  const first = await s.readSince(0, 4);
  assert.equal(first.length, 4);
  const rest = await s.readSince(first[3].ingestSeq, 100);
  assert.equal(rest.length, 6);
  assert.equal((await s.readSince(0, 100, { origin: 'local' })).length, 7);
  await s.setMeta('cursor', 42);
  assert.equal(await s.getMeta('cursor'), '42');
  assert.equal(await s.getMeta('missing'), null);
});

test('snapshots round-trip and file stores persist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-'));
  const file = path.join(dir, 'x.db');
  const s = await openStore(file);
  await s.append(events('a', 2));
  await s.putSnapshot({ name: 'p:d', version: 1, watermark: 'w', ingestSeq: 2, state: { x: [1, 2] }, builtAt: 1 });
  await s.close();
  const s2 = await openStore(file);
  assert.equal(await s2.count(), 2);
  assert.deepEqual((await s2.getSnapshot('p:d')).state, { x: [1, 2] });
  await s2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('git-ledger export/import is a union merge that never duplicates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loam-ledger-'));
  const a = await openStore(':memory:');
  await a.append(events('nodeA', 4));
  assert.equal((await exportLedger(a, dir)).written, 4);
  assert.equal((await exportLedger(a, dir)).written, 0, 'second export writes nothing new');
  const b = await openStore(':memory:');
  await b.append(events('nodeB', 2, { t: 2000 }));
  await importLedger(b, dir);
  assert.equal(await b.count(), 6);
  await exportLedger(b, dir);
  const c = await openStore(':memory:');
  await importLedger(c, dir);
  assert.equal(await c.count(), 6, 'imported events are not re-exported (origin=ledger), so nothing doubles');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['nodeA.jsonl', 'nodeB.jsonl']);
  fs.rmSync(dir, { recursive: true, force: true });
});

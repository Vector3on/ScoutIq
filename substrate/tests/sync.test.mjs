import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core/store.mjs';
import { makeEvent, Clock, makeRng } from '../core/events.mjs';
import { sync } from '../core/sync.mjs';
import { project, foldEvents } from '../core/projections.mjs';
import { memoryProjection } from '../core/memory.mjs';

function observation(node, seq, clock, t, key, text, topics) {
  return makeEvent({
    node, seq, hlc: clock.tick(), kind: 'observation.seen', ts: t, domain: 'd', dedupKey: `obs:s:${key}`,
    body: { sensor: 's', externalId: key, observedAt: t, text, entities: [{ type: 'paper', key, text, signals: { n: seq } }, ...topics.map((x) => ({ type: 'topic', key: x }))], relations: topics.map((x) => ({ from: `paper:${key}`, rel: 'in_topic', to: `topic:${x}` })) },
  });
}

function fingerprint(state) {
  const ents = [...state.entities.values()].map((e) => [e.id, e.firstSeen, e.lastSeen, e.n, [...e.signals].map(([k, s]) => [k, s.points])]).sort();
  const rels = [...state.relations.values()].map((r) => [r.from, r.rel, r.to, r.firstSeen, r.n]).sort();
  return JSON.stringify({ ents, rels, docs: state.terms.docs, df: [...state.terms.df].sort() });
}

test('two replicas and a hub converge to identical projections (G-Set + HLC fold)', async () => {
  const hub = await openStore(':memory:');
  const A = await openStore(':memory:'), B = await openStore(':memory:');
  const ca = new Clock('A', () => 1000), cb = new Clock('B', () => 1000);
  const evA = Array.from({ length: 6 }, (_, i) => observation('A', i + 1, ca, 1000 + i * 3600e3, `a${i}`, `alpha token${i} shared`, ['t1', i % 2 ? 't2' : 't3']));
  const evB = Array.from({ length: 6 }, (_, i) => observation('B', i + 1, cb, 900 + i * 3600e3, `b${i}`, `beta token${i} shared`, ['t2', 't4']));
  await A.append(evA);
  await B.append(evB);
  await sync(A, hub); await sync(B, hub); await sync(A, hub);
  assert.equal(await A.count(), 12); assert.equal(await B.count(), 12); assert.equal(await hub.count(), 12);
  const pa = await project(A, memoryProjection, { domain: 'd' }), pb = await project(B, memoryProjection, { domain: 'd' });
  assert.equal(fingerprint(pa.state), fingerprint(pb.state));
  // Re-sync is a no-op
  const r = await sync(A, hub);
  assert.deepEqual([r.pulled, r.pushed], [0, 0]);
});

test('fold is arrival-order independent, and snapshots stay exact under late arrivals', async () => {
  const c = new Clock('X', () => 5000);
  const all = Array.from({ length: 30 }, (_, i) => observation('X', i + 1, c, 5000 + (i % 7) * 86400e3, `k${i % 9}`, `w${i} w${(i * 3) % 5} common`, ['t' + (i % 3), 't' + ((i * 2) % 4)]));
  const rng = makeRng(3);
  const base = fingerprint(foldEvents(memoryProjection, all, { domain: 'd' }).state);
  for (let trial = 0; trial < 5; trial++) assert.equal(fingerprint(foldEvents(memoryProjection, rng.shuffle(all), { domain: 'd' }).state), base);
  // Snapshot path: ingest the later half first, snapshot, then the earlier half arrives late (lower HLCs).
  const s = await openStore(':memory:');
  await s.append(all.slice(15));
  const p1 = await project(s, memoryProjection, { domain: 'd' });
  assert.equal(p1.replayed, false);
  await s.append(all.slice(0, 15));
  const p2 = await project(s, memoryProjection, { domain: 'd' });
  assert.equal(p2.replayed, true, 'late arrival below the watermark forces an exact replay');
  assert.equal(fingerprint(p2.state), base);
  const p3 = await project(s, memoryProjection, { domain: 'd' });
  assert.equal(p3.applied, 0);
  assert.equal(fingerprint(p3.state), base, 'hydrated snapshot equals a from-scratch fold');
});

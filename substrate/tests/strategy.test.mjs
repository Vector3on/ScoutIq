import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng, makeEvent, Clock } from '../core/events.mjs';
import { foldEvents } from '../core/projections.mjs';
import { memoryProjection, MemoryVectors, DAY_MS } from '../core/memory.mjs';
import { randomGenome, mutate, crossover, runStrategy, describeBehavior, cellOf, DegreeRanks, genomeId, canonicalGenomes, MAX_PIPE, PIPE_OPS, bridgeScore } from '../core/strategy.mjs';

const schema = {
  entityTypes: ['paper', 'author', 'topic'], primaryType: 'paper',
  relations: [{ rel: 'authored_by', from: 'paper', to: 'author' }, { rel: 'in_topic', from: 'paper', to: 'topic' }, { rel: 'active_in', from: 'author', to: 'topic' }],
  signals: [{ name: 'heat', type: 'topic' }, { name: 'cites', type: 'paper' }],
};
const T0 = Date.UTC(2026, 0, 1);

/** Hand-built memory: 20 days of papers; author a1 migrates to t3 on day 15; pair (t0,t2) co-occurs only recently. */
function buildMemory() {
  const c = new Clock('m', () => 1);
  const evs = [];
  let seq = 0;
  const obs = (day, key, author, topics, text, cites) => {
    const t = T0 + day * DAY_MS;
    evs.push(makeEvent({ node: 'm', seq: ++seq, hlc: c.tick(), kind: 'observation.seen', ts: t, domain: 'd', dedupKey: `o:${key}`, body: {
      sensor: 's', externalId: key, observedAt: t, text,
      entities: [{ type: 'paper', key, text, signals: { cites } }, { type: 'author', key: author }, ...topics.map((x) => ({ type: 'topic', key: x, signals: { heat: day } }))],
      relations: [{ from: `paper:${key}`, rel: 'authored_by', to: `author:${author}` }, ...topics.map((x) => ({ from: `paper:${key}`, rel: 'in_topic', to: `topic:${x}` })), ...topics.map((x) => ({ from: `author:${author}`, rel: 'active_in', to: `topic:${x}` }))],
    } }));
  };
  for (let d = 0; d < 20; d++) {
    obs(d, `p${d}a`, 'a1', d < 15 ? ['t0'] : ['t3'], `alpha beta gamma common${d % 3}`, d);
    obs(d, `p${d}b`, 'a2', ['t1'], `delta epsilon common${d % 2}`, 20 - d);
    obs(d, `p${d}c`, `a${3 + (d % 4)}`, d >= 17 ? ['t0', 't2'] : ['t2'], d >= 17 ? 'zeta eta newterm' : 'zeta eta', d * d);
  }
  return foldEvents(memoryProjection, evs, { domain: 'd' }).state;
}

test('random genomes are schema-valid and every op executes without error; interpreter is deterministic', () => {
  const memory = buildMemory();
  const rng = makeRng(1);
  const ctx = { memory, vectors: new MemoryVectors(memory), now: T0 + 20 * DAY_MS, value: () => 0.5, k: 10 };
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const g = randomGenome(schema, rng);
    assert.ok(g.pipe.length <= MAX_PIPE);
    for (const op of g.pipe) { assert.ok(PIPE_OPS.includes(op.op)); seen.add(op.op); }
    const a = runStrategy(g, ctx), b = runStrategy(g, ctx);
    assert.deepEqual(a.items.map((x) => x.id), b.items.map((x) => x.id));
    assert.ok(a.items.length <= 10);
  }
  assert.equal(seen.size, PIPE_OPS.length, `all ops exercised: ${[...seen]}`);
});

test('mutation changes the genome, crossover respects the size cap, ids are canonical', () => {
  const rng = makeRng(2);
  for (let i = 0; i < 100; i++) {
    const g = randomGenome(schema, rng);
    const m = mutate(g, schema, rng);
    assert.notEqual(genomeId(m), genomeId(g));
    const x = crossover(g, randomGenome(schema, rng), rng);
    assert.ok(x.pipe.length <= MAX_PIPE);
  }
  assert.equal(genomeId({ seed: { op: 'all', type: 'paper' }, pipe: [], rank: { by: 'value' } }), genomeId({ rank: { by: 'value' }, pipe: [], seed: { type: 'paper', op: 'all' } }));
  assert.ok(canonicalGenomes(schema).length >= 3);
});

test('graph/time operators find the planted structure: migration, emerging bridge, silence, new edges', () => {
  const memory = buildMemory();
  const now = T0 + 20 * DAY_MS;
  const ctx = { memory, vectors: new MemoryVectors(memory), now, value: () => 0.5, k: 10 };
  // newcomer: author a1 (known since day 0) got a new active_in edge (t3) on day 15
  const nc = runStrategy({ seed: { op: 'all', type: 'author' }, pipe: [{ op: 'newcomer', rel: 'active_in', dir: 'out', recentDays: 7, priorDays: 7 }], rank: { by: 'value' } }, ctx);
  assert.deepEqual(nc.items.map((x) => x.id).sort(), ['author:a1', 'author:a4', 'author:a5', 'author:a6'], 'a1 migrated to t3; a4..a6 newly entered t0');
  assert.match(nc.items.find((x) => x.id === 'author:a1').rationale[0], /new active_in link to t3/);
  // emerging bridge: papers in (t0,t2) — a pair that only co-occurs since day 17
  const br = runStrategy({ seed: { op: 'recent', type: 'paper', days: 7 }, pipe: [{ op: 'bridge', rel: 'in_topic', dir: 'out', mode: 'emerging', days: 7, q: 0.5 }], rank: { by: 'recency' } }, ctx);
  assert.ok(br.items.length >= 3 && br.items.every((x) => /^paper:p1[789]c$/.test(x.id)), JSON.stringify(br.items.map((x) => x.id)));
  const bs = bridgeScore(memory, 'paper:p19c', 'in_topic', 'out', { mode: 'emerging', days: 7, now });
  assert.ok(bs.score > 0 && bs.pair.join() === 'topic:t0,topic:t2');
  // silent: no topic went silent (all observed daily) but a query for stale papers returns old ones only
  const st = runStrategy({ seed: { op: 'stale', type: 'paper', minDays: 10, maxDays: 365 }, pipe: [], rank: { by: 'age' } }, ctx);
  assert.ok(st.items.length > 0 && st.items.every((x) => memory.entities.get(x.id).lastSeen <= now - 10 * DAY_MS));
  // viaNewEdge: from topic t3, papers linked within the last 7 days
  const ne = runStrategy({ seed: { op: 'all', type: 'topic' }, pipe: [{ op: 'viaNewEdge', rel: 'in_topic', dir: 'in', days: 3 }], rank: { by: 'recency' } }, ctx);
  assert.ok(ne.items.every((x) => memory.entities.get(x.id).firstSeen >= now - 3 * DAY_MS - 1));
  // rising / rareTerms: 'newterm' appears only from day 17
  const rt = runStrategy({ seed: { op: 'recent', type: 'paper', days: 3 }, pipe: [{ op: 'rareTerms', q: 0.7 }], rank: { by: 'surprisal' } }, ctx);
  assert.ok(rt.items.length > 0 && rt.items[0].id.endsWith('c'));
  // accelerating: paper cites signal d*d for c-papers? (single point per paper) → topic heat accelerates linearly → zero; none kept
  const acc = runStrategy({ seed: { op: 'all', type: 'topic' }, pipe: [{ op: 'accelerating', signal: 'heat', q: 0.5 }], rank: { by: 'value' } }, ctx);
  assert.equal(acc.items.length, 0, 'linear growth is not acceleration');
  // novelty-aware ranking: non-novel ids are excluded from the k slots
  const lim = runStrategy({ seed: { op: 'all', type: 'paper' }, pipe: [], rank: { by: 'recency' } }, { ...ctx, isNovel: (id) => id !== 'paper:p19a' });
  assert.ok(!lim.items.some((x) => x.id === 'paper:p19a'));
});

test('behavior descriptors are in [0,1]^3 and map to grid cells', () => {
  const memory = buildMemory();
  const now = T0 + 20 * DAY_MS;
  const ctx = { memory, vectors: new MemoryVectors(memory), now, value: () => 0.5, k: 10 };
  const ranks = new DegreeRanks(memory);
  const rng = makeRng(5);
  const cells = new Set();
  for (let i = 0; i < 100; i++) {
    const out = runStrategy(randomGenome(schema, rng), ctx);
    const bd = describeBehavior(out.items, ctx, ranks);
    if (!bd) { assert.equal(out.items.length, 0); continue; }
    for (const k of ['age', 'centrality', 'spread']) assert.ok(bd[k] >= 0 && bd[k] <= 1, `${k}=${bd[k]}`);
    const cell = cellOf(bd, 6);
    assert.match(cell, /^[0-5]-[0-5]-[0-5]$/);
    cells.add(cell);
  }
  assert.ok(cells.size >= 4, `distinct cells: ${cells.size}`);
  assert.equal(cellOf(null, 6), null);
  assert.equal(ranks.percentile('paper', 0), 0);
});

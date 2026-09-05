// v4 addon tests (DESIGN.md §10): learned observables, hindsight labels and the label model, time travel,
// the v4 value model (equal to v3 on a v3 log; precision-weighted hindsight rows; rebuild on adoption),
// retrospective curriculum, learning progress, the grown strategy grammar, and the additivity contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEvent, Clock, makeRng } from '../core/events.mjs';
import { foldEvents, project } from '../core/projections.mjs';
import { memoryProjection, MemoryVectors, DAY_MS } from '../core/memory.mjs';
import { DegreeRanks, randomGenome, runStrategy, genomeId, OBS_OP } from '../core/strategy.mjs';
import { SignalRanks } from '../core/phenotype.mjs';
import { makeObsContext, evalAll, randomProgram, mutateProgram, observableId, programSize, programShape, candidateFitness, obsCorrelation, quantileEdges, bucketOf, MAX_NODES, describeProgram } from '../core/observables.mjs';
import { hindsightComponents, makeLabelModel, labelOf, labelPrior, spearman } from '../core/hindsight.mjs';
import { memoryAsOf, pastRuns } from '../core/timetravel.mjs';
import { makeValueModelProjection, predictValue, selectJudgments } from '../core/valuemodel.mjs';
import { makeValueModelV4Projection, phiOf, ensureModel, residualRows, activeObservables, takeIg, V4_KINDS } from '../core/valuemodel-v4.mjs';
import { makeFrontierProjection } from '../core/frontier.mjs';
import { makeCurriculumProjection, retroSpec, retroId, harderRetro, retroCriterion, labelsForDay, activeRetro } from '../core/curriculum.mjs';
import { makeProgressProjection, diagnoseProgress, slope } from '../core/progress.mjs';
import { openStore } from '../core/store.mjs';
import { loadPlugin } from '../core/plugins.mjs';
import { runOnce } from '../core/worker.mjs';
import { runVariant, VARIANT_CONFIGS, V4_DEFAULT } from '../core/experiment.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EPOCH = Date.UTC(2026, 0, 1);
const T0 = EPOCH;
const schema = {
  entityTypes: ['paper', 'author', 'topic'], primaryType: 'paper',
  relations: [{ rel: 'authored_by', from: 'paper', to: 'author' }, { rel: 'in_topic', from: 'paper', to: 'topic' }, { rel: 'active_in', from: 'author', to: 'topic' }],
  signals: [{ name: 'heat', type: 'topic' }, { name: 'cites', type: 'paper' }],
};

/**
 * A world with a future: 30 days of papers. (t0,t1) is a habitual pair from day 0; (t2,t3) starts co-occurring on
 * day 20 and grows; author a9 migrates into t3 on day 22 with a burst; token `emergx` appears from day 21.
 * Events carry ts = the day's noon + a small offset, so time travel by log time is meaningful.
 */
function buildWorld() {
  const c = new Clock('w', () => 1);
  const evs = [];
  let seq = 0;
  const obs = (day, key, author, topics, text, cites = 1) => {
    const t = T0 + day * DAY_MS, ts = T0 + day * DAY_MS + 12 * 3600 * 1000 + seq;
    evs.push(makeEvent({ node: 'w', seq: ++seq, hlc: c.tick(), kind: 'observation.seen', ts, domain: 'd', dedupKey: `o:${key}`, body: {
      sensor: 's', externalId: key, observedAt: t, text, params: 'p',
      entities: [{ type: 'paper', key, text, signals: { cites } }, { type: 'author', key: author }, ...topics.map((x) => ({ type: 'topic', key: x, signals: { heat: 2 + (day >= 21 && (x === 't2' || x === 't3') ? 3 : 0) } }))],
      relations: [{ from: `paper:${key}`, rel: 'authored_by', to: `author:${author}` }, ...topics.map((x) => ({ from: `paper:${key}`, rel: 'in_topic', to: `topic:${x}` })), ...topics.map((x) => ({ from: `author:${author}`, rel: 'active_in', to: `topic:${x}` }))],
    } }));
  };
  for (let d = 0; d < 30; d++) {
    obs(d, `h${d}`, `a${d % 4}`, ['t0', 't1'], `alpha beta common${d % 3}`);                 // habitual pair, every day
    obs(d, `s${d}`, `a${4 + (d % 3)}`, ['t2'], `gamma delta common${d % 2}`);                 // plain t2 paper
    if (d >= 20) for (let k = 0; k < 3; k++) obs(d, `x${d}${k}`, `a${4 + ((d + k) % 3)}`, ['t2', 't3'], `gamma epsilon${k}${d >= 21 ? ' emergx' : ''}`); // hot pair from day 20
    if (d >= 22) for (let k = 0; k < 2; k++) obs(d, `m${d}${k}`, 'a9', ['t3'], `zeta eta${k}`); // a9 migrates into t3
    if (d < 22 && d % 2 === 0) obs(d, `o${d}`, 'a9', ['t0'], `zeta theta`);                    // a9's old home
  }
  return evs;
}

test('observable grammar: programs are small, typed by schema, mutable, describable; the evaluator is deterministic and total', () => {
  const rng = makeRng(11);
  const shapes = new Set();
  for (let i = 0; i < 500; i++) {
    const p = randomProgram(schema, 'paper', rng, 2);
    assert.ok(programSize(p) <= MAX_NODES);
    shapes.add(programShape(p));
    const m = mutateProgram(p, schema, 'paper', rng);
    assert.notEqual(observableId(m), observableId(p));
    assert.ok(programSize(m) <= MAX_NODES);
    assert.equal(typeof describeProgram(p), 'string');
  }
  assert.ok(shapes.size > 100, `kinds of observables: ${shapes.size}`);
  const memory = foldEvents(memoryProjection, buildWorld(), { domain: 'd' }).state;
  const now = T0 + 29 * DAY_MS + 13 * 3600 * 1000;
  const ctx = makeObsContext({ memory, now, schema, degreeRanks: new DegreeRanks(memory), signalRanks: new SignalRanks(memory, schema.signals) });
  const ctx2 = makeObsContext({ memory, now, schema, degreeRanks: new DegreeRanks(memory), signalRanks: new SignalRanks(memory, schema.signals) });
  const ids = [...memory.byType.get('paper')].slice(0, 40);
  for (let i = 0; i < 200; i++) {
    const p = randomProgram(schema, 'paper', rng, 2);
    for (const id of ids) { const v = ctx.eval(p, id); assert.ok(v === null || Number.isFinite(v)); assert.equal(v, ctx2.eval(p, id)); }
  }
  // a pair observable sees the hot pair: co-count of (t2,t3) is large for an x-paper and null for a single-topic paper
  const coCount = { f: 'pair', rel1: 'in_topic', dir1: 'out', rel2: 'in_topic', dir2: 'out', stat: 'coCount', agg: 'max' };
  assert.ok(ctx.eval(coCount, 'paper:x280') > Math.log1p(20));
  assert.equal(ctx.eval(coCount, 'paper:s5'), null);
  const coAge = { f: 'pair', rel1: 'in_topic', dir1: 'out', rel2: 'in_topic', dir2: 'out', stat: 'coAge', agg: 'min' };
  assert.ok(ctx.eval(coAge, 'paper:x280') < ctx.eval(coAge, 'paper:h28'), 'the hot pair is younger than the habitual pair');
  const nbr = { f: 'nbr', rel: 'authored_by', dir: 'out', agg: 'max', inner: { f: 'deg', rel: 'active_in', dir: 'out' } };
  assert.ok(ctx.eval(nbr, 'paper:m250') >= Math.log1p(2), 'a9 is active in two topics');
  assert.equal(evalAll(ctx, [{ id: 'a', program: coCount }, { id: 'b', program: nbr }], 'paper:x280').a, ctx.eval(coCount, 'paper:x280'));
});

test('observable fitness: a candidate that explains the residual scores high, an unrelated one does not; redundancy is detected', () => {
  const rng = makeRng(3);
  const rows = [];
  for (let i = 0; i < 400; i++) {
    const z = rng(), u = rng();
    rows.push({ obs: { good: z, twin: z * 2 + 0.01 * u, noise: u }, r: (z > 0.7 ? 0.3 : -0.05) + 0.05 * rng.gauss(), batch: i % 4 });
  }
  const good = candidateFitness('good', rows), noise = candidateFitness('noise', rows);
  assert.ok(good.fitness > 0.5, `good ${good.fitness}`);
  assert.ok(noise.fitness < 0.05, `noise ${noise.fitness}`);
  assert.equal(candidateFitness('good', rows.slice(0, 50)).fitness, null, 'not enough rows');
  assert.equal(candidateFitness('good', rows.filter((r) => r.batch === 0)).fitness, null, 'needs two batches');
  assert.ok(Math.abs(obsCorrelation('good', 'twin', rows)) > 0.95 && Math.abs(obsCorrelation('good', 'noise', rows)) < 0.2);
  const edges = quantileEdges([5, 1, 4, 2, 3, 0, 9, 8, 7, 6]);
  assert.equal(edges.length, 4);
  assert.equal(bucketOf(-1, edges), 'b0'); assert.equal(bucketOf(100, edges), 'b4'); assert.equal(bucketOf(null, edges), 'na');
});

test('hindsight: growth components find the future (hot pair, migration, emerging term); the label model calibrates on judgments', () => {
  const memory = foldEvents(memoryProjection, buildWorld(), { domain: 'd' }).state;
  const asOf = T0 + 20 * DAY_MS + 12 * 3600 * 1000;
  const hot = hindsightComponents('paper:x200', { memory, asOf, horizon: 7, schema });
  const habitual = hindsightComponents('paper:h20', { memory, asOf, horizon: 7, schema });
  assert.ok(hot['pair:in_topic×in_topic'] > 0.6, `hot pair grows: ${JSON.stringify(hot)}`);
  assert.ok(habitual['pair:in_topic×in_topic'] < 0.35, `habitual pair does not: ${JSON.stringify(habitual)}`);
  assert.ok(hot['sig:in_topic:heat'] > habitual['sig:in_topic:heat'], 'the hot topics heat up');
  const asOf22 = T0 + 22 * DAY_MS + 12 * 3600 * 1000;
  const mig = hindsightComponents('paper:m220', { memory, asOf: asOf22, horizon: 7, schema });
  const stay = hindsightComponents('paper:s22', { memory, asOf: asOf22, horizon: 7, schema });
  assert.ok(mig['pair:authored_by×in_topic'] > stay['pair:authored_by×in_topic'], `migration: ${mig['pair:authored_by×in_topic']} vs ${stay['pair:authored_by×in_topic']}`);
  const asOf21 = T0 + 21 * DAY_MS + 12 * 3600 * 1000;
  const term = hindsightComponents('paper:x210', { memory, asOf: asOf21, horizon: 7, schema });
  assert.ok(term.term > hindsightComponents('paper:h21', { memory, asOf: asOf21, horizon: 7, schema }).term, 'emergx rises');
  assert.equal(hindsightComponents('paper:nope', { memory, asOf, horizon: 7, schema }), null);
  for (const v of Object.values(hot)) assert.ok(v >= 0 && v <= 1);
  // label model: judgments teach it that pair growth (not degree growth) is what the operator values
  const lm = makeLabelModel();
  const c = (pair, deg) => ({ 'pair:in_topic×in_topic': pair, 'deg:in_topic': deg });
  const before = labelOf(lm, c(0.9, 0.1));
  for (let i = 0; i < 80; i++) {
    const pair = (i % 5) / 5, deg = ((i * 7) % 5) / 5;
    const comps = c(pair, deg), truth = 0.8 * pair;
    lm.update(labelPhiOf(comps), truth - labelPrior(comps));
  }
  const high = labelOf(lm, c(0.9, 0.1)), low = labelOf(lm, c(0.1, 0.9));
  assert.ok(high.value > 0.55 && low.value < 0.3 && high.value - low.value > 0.35, `calibrated: ${high.value} vs ${low.value}`);
  assert.ok(high.variance < before.variance, 'variance shrinks with pairs');
  assert.ok(Math.abs(spearman([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-9);
});
import { labelPhi as labelPhiOf } from '../core/hindsight.mjs';

test('time travel: memory as of a cutoff is the fold of the prefix, with ingestion times', async () => {
  const evs = buildWorld();
  const store = await openStore(':memory:');
  await store.append(evs);
  const cutoff = T0 + 20 * DAY_MS + 13 * 3600 * 1000;
  const at = await memoryAsOf(store, { domain: 'd', cutoffTs: cutoff });
  const full = foldEvents(memoryProjection, evs, { domain: 'd' }).state;
  const prefix = foldEvents(memoryProjection, evs.filter((e) => e.ts <= cutoff), { domain: 'd' }).state;
  assert.equal(at.entities.size, prefix.entities.size);
  assert.ok(at.entities.size < full.entities.size);
  assert.ok(at.entities.has('paper:x200') && !at.entities.has('paper:x210'));
  assert.equal(at.ingestedAt.get('paper:x200'), evs.find((e) => e.body.externalId === 'x200').ts);
  assert.ok(at.ingestedAt.get('author:a0') < at.ingestedAt.get('paper:x200'));
  assert.deepEqual(await pastRuns(store, 'd'), []);
});

function evs(node, kind, bodies, domain = 'd') {
  const c = new Clock(node, () => 1);
  return bodies.map((body, i) => makeEvent({ node, seq: i + 1, hlc: c.tick(), kind: Array.isArray(kind) ? kind[i] : kind, ts: body.ts ?? 1, domain, body }));
}
const feats = (kind) => ({ 'type=paper': 1, [`kind=${kind}`]: 1 });
const PROG = { f: 'pair', rel1: 'in_topic', dir1: 'out', rel2: 'in_topic', dir2: 'out', stat: 'coAge', agg: 'min' };

test('v4 value model: equals the v3 model on a v3 log; hindsight rows are weaker evidence than judgments; adoption rebuilds the feature space', () => {
  const opts = { dim: 64, priorVar: 0.25, noiseVar: 0.05 };
  const bodies = [], kinds = [];
  for (let i = 0; i < 12; i++) {
    const kind = i % 2 ? 'A' : 'B';
    bodies.push({ entityId: `paper:${i}`, features: feats(kind), pluginScore: 0.3, ts: i }); kinds.push('value.features');
    bodies.push({ entityId: `paper:${i}`, value: kind === 'A' ? 0.7 : 0.05, by: 'oracle', ts: i }); kinds.push('judgment.recorded');
  }
  const log = evs('v', kinds, bodies);
  const v3 = foldEvents(makeValueModelProjection(opts), log, { domain: 'd' }).state;
  const v4 = foldEvents(makeValueModelV4Projection(opts), log, { domain: 'd' }).state;
  assert.equal(predictValue(v4, feats('A'), 0.3).value, predictValue(v3, feats('A'), 0.3).value);
  assert.equal(predictValue(v4, feats('Z'), 0.3).sd, predictValue(v3, feats('Z'), 0.3).sd);
  assert.equal(v4.trained, 12); assert.equal(v4.absErr, v3.absErr);
  assert.equal(v4.rows.length, 12); assert.equal(v4.hindRows, 0);
  // a hindsight row for a new kind moves the prediction, but less than a judgment would
  const hind = evs('h', 'hindsight.labeled', [{ entityId: 'paper:h1', asOf: 100 * DAY_MS, asOfDay: 100, horizonDays: 7, components: { 'pair:in_topic×in_topic': 0.9, term: 0.1 }, features: feats('C'), obs: { o1: 0.5 }, pluginScore: 0.3, novelAt: 1, ts: 107 * DAY_MS }]);
  const withHind = foldEvents(makeValueModelV4Projection(opts), [...log, ...hind], { domain: 'd' }).state;
  const judged = foldEvents(makeValueModelV4Projection(opts), [...log, ...evs('j', ['value.features', 'judgment.recorded'], [{ entityId: 'paper:h1', features: feats('C'), pluginScore: 0.3, ts: 107 * DAY_MS }, { entityId: 'paper:h1', value: 0.45, by: 'oracle', ts: 107 * DAY_MS }])], { domain: 'd' }).state;
  const base = predictValue(v4, feats('C'), 0.3).value, pH = predictValue(withHind, feats('C'), 0.3).value, pJ = predictValue(judged, feats('C'), 0.3).value;
  assert.equal(withHind.hindRows, 1); assert.equal(withHind.labelledDays.has(100), true);
  assert.ok(pH > base && pJ > base, `both move up: ${base} → ${pH} / ${pJ}`);
  assert.ok(Math.abs(pJ - base) > Math.abs(pH - base), `a judgment (${pJ}) outweighs a hindsight label (${pH})`);
  assert.ok(withHind.ig > 0 && takeIg(withHind) > 0 && withHind.ig === 0, 'information gain is accumulated and taken');
  const hrow = withHind.rows.find((r) => r.kind === 'hindsight');
  assert.ok(hrow && hrow.prec < 1 / opts.noiseVar, 'a hindsight row carries less precision than a judgment row');
  // a judgment near the label's asOf trains the label model
  const paired = foldEvents(makeValueModelV4Projection(opts), [...log, ...hind, ...evs('j2', 'judgment.recorded', [{ entityId: 'paper:h1', value: 0.9, by: 'oracle', ts: 101 * DAY_MS }])], { domain: 'd' }).state;
  assert.equal(paired.labelPairs, 1);
  // an empty day marker counts the day as done
  const empty = foldEvents(makeValueModelV4Projection(opts), evs('e', 'hindsight.labeled', [{ asOfDay: 55, horizonDays: 7, empty: true, ts: 1 }]), { domain: 'd' }).state;
  assert.ok(empty.labelledDays.has(55) && empty.rows.length === 0);
  // observables: proposed → candidate; adopted → feature space revision and rebuild; retired
  const obsLog = evs('o', ['observable.proposed', 'observable.adopted', 'observable.proposed', 'observable.retired'], [
    { id: 'o1', program: PROG, type: 'paper', ts: 1 },
    { id: 'o1', program: PROG, type: 'paper', edges: [0.2, 0.4, 0.6, 0.8], fitness: 0.05, n: 200, ts: 2 },
    { id: 'o2', program: { f: 'age' }, type: 'paper', ts: 3 },
    { id: 'o2', reason: 'unfit', ts: 4 },
  ]);
  const adopted = foldEvents(makeValueModelV4Projection(opts), [...log, ...hind, ...obsLog], { domain: 'd' }).state;
  assert.equal(adopted.observables.adopted.size, 1); assert.equal(adopted.observables.candidates.size, 0); assert.equal(adopted.observables.retired, 1); assert.equal(adopted.observables.rev, 1);
  assert.ok(adopted.rebuilds + (adopted.dirty ? 1 : 0) >= 1, 'adoption schedules a rebuild (done lazily, or by the next row)');
  const phiA = phiOf(adopted, feats('C'), { o1: 0.5 }), phiB = phiOf(adopted, feats('C'), { o1: 0.95 });
  assert.notDeepEqual(phiA, phiB, 'the adopted observable is part of the feature vector');
  ensureModel(adopted); assert.equal(adopted.dirty, false); assert.ok(adopted.rebuilds >= 1); assert.equal(ensureModel(adopted), false);
  assert.equal(residualRows(adopted).length, 13);
  assert.deepEqual(activeObservables(adopted).map((o) => o.id), ['o1']);
  const again = makeValueModelV4Projection(opts).hydrate(JSON.parse(JSON.stringify(makeValueModelV4Projection(opts).dehydrate(adopted))));
  assert.ok(Math.abs(predictValue(again, feats('C'), 0.3, { o1: 0.5 }).value - predictValue(adopted, feats('C'), 0.3, { o1: 0.5 }).value) < 1e-9, 'round trip');
  const picked = selectJudgments(adopted, [{ entityId: 'paper:new', features: feats('A'), obs: { o1: 0.5 }, pluginScore: 0.3, score: 0.5 }], { k: 1, mode: 'ei', cutoff: 0.2 });
  assert.equal(picked.length, 1);
});

test('curriculum: retro environments fold into their own projection, not the frontier; minimal criterion; harder children; labels per day', () => {
  const spec = retroSpec({ asOfDay: 100, cutoffTs: 100 * DAY_MS, now: 100 * DAY_MS + 1000, minValue: 0.3 });
  const live = { minValue: 0.4, region: { type: 'paper', ageMin: null, ageMax: null } };
  const list = evs('c', ['challenge.created', 'challenge.created', 'challenge.evaluated', 'challenge.evaluated', 'challenge.retired'], [
    { challengeId: retroId(spec), spec, parent: null, origin: 'schedule', ts: 1 },
    { challengeId: 'live1', spec: live, parent: null, origin: 'schedule', ts: 1 },
    { challengeId: retroId(spec), genomeId: 'g1', genome: { seed: { op: 'all', type: 'paper' }, pipe: [], rank: { by: 'value' } }, fitness: 0.3, kind: 'random', ts: 2 },
    { challengeId: 'live1', genomeId: 'g2', genome: { seed: { op: 'all', type: 'paper' }, pipe: [], rank: { by: 'value' } }, fitness: 0.1, kind: 'random', ts: 2 },
    { challengeId: retroId(spec), reason: 'solved', ts: 3 },
  ]);
  const cu = foldEvents(makeCurriculumProjection(), list, { domain: 'd' }).state;
  const fr = foldEvents(makeFrontierProjection(), list, { domain: 'd' }).state;
  assert.deepEqual([...cu.challenges.keys()], [retroId(spec)]);
  assert.deepEqual([...fr.challenges.keys()], ['live1']);
  assert.equal(cu.solved, 1); assert.equal(cu.evaluations, 1); assert.equal(fr.evaluations, 1);
  assert.equal(activeRetro(cu).length, 0);
  assert.equal(harderRetro(spec).minValue, 0.4); assert.equal(harderRetro({ ...spec, minValue: 0.8 }).minValue, 0.8);
  assert.equal(retroCriterion({ status: 'active', evaluations: 10, best: 0.001 }), 'impossible');
  assert.equal(retroCriterion({ status: 'active', evaluations: 2, best: 0.3 }), 'solved');
  assert.equal(retroCriterion({ status: 'active', evaluations: 50, best: 0.1 }), 'stale');
  assert.equal(retroCriterion({ status: 'active', evaluations: 3, best: 0.1 }), 'active');
  const vm = { rows: [{ id: 'paper:a', kind: 'hindsight', batch: 100, y: 0.7, nv: 1 }, { id: 'paper:b', kind: 'hindsight', batch: 100, y: 0.2, nv: 0 }, { id: 'paper:c', kind: 'hindsight', batch: 99, y: 0.9, nv: 1 }, { id: 'paper:d', kind: 'judgment', batch: 100, y: 0.9 }] };
  const labels = labelsForDay(vm, 100);
  assert.deepEqual([...labels.keys()], ['paper:a', 'paper:b']);
  assert.equal(labels.get('paper:b').novel, 0);
});

test('progress: warms up, measures learning progress from the hindsight error slope, declares a stall only when nothing moves', () => {
  const proj = makeProgressProjection();
  const mk = (i, mae, adopted, shapes) => ({ runId: `r${i}`, startedAt: i, valuePerSecond: 0.1, novelValue: 1, v4: { hindsight: { mae, ig: 1 }, observables: { adoptedThisRun: adopted, newShapesThisRun: shapes, adopted: 3 } } });
  const learning = Array.from({ length: 12 }, (_, i) => mk(i, 0.2 - 0.01 * i, i % 4 === 0 ? 1 : 0, i % 8 === 0 ? 1 : 0));
  const s1 = foldEvents(proj, evs('p', 'run.completed', learning), { domain: 'd' }).state;
  assert.equal(diagnoseProgress(foldEvents(proj, evs('p', 'run.completed', learning.slice(0, 5)), { domain: 'd' }).state).reason, 'warming-up');
  const d1 = diagnoseProgress(s1);
  assert.equal(d1.stalled, false); assert.ok(d1.lpValue > 0);
  const flat = [...learning, ...Array.from({ length: 10 }, (_, i) => mk(20 + i, 0.08 + 0.001 * (i % 2), 0, 0))];
  const d2 = diagnoseProgress(foldEvents(proj, evs('p', 'run.completed', flat), { domain: 'd' }).state);
  assert.equal(d2.stalled, true); assert.equal(d2.adoptions, 0);
  assert.ok(Math.abs(slope([1, 2, 3, 4]) - 1) < 1e-9);
});

test('grown grammar: with adopted observables the DSL proposes obsFilter/obs-ranked genomes; the interpreter uses ctx.obs and is a no-op without it', () => {
  const memory = foldEvents(memoryProjection, buildWorld(), { domain: 'd' }).state;
  const now = T0 + 29 * DAY_MS + 13 * 3600 * 1000;
  const octx = makeObsContext({ memory, now, schema, degreeRanks: new DegreeRanks(memory), signalRanks: new SignalRanks(memory, schema.signals) });
  const grown = { ...schema, observables: [{ id: 'o_coage', type: 'paper' }] };
  const rng = makeRng(9);
  let used = 0;
  for (let i = 0; i < 300; i++) { const g = randomGenome(grown, rng); if (g.pipe.some((op) => op.op === OBS_OP) || g.rank.by === 'obs') used++; }
  assert.ok(used > 30 && used < 250, `grammar uses observables sometimes: ${used}/300`);
  let plain = 0;
  for (let i = 0; i < 300; i++) { const g = randomGenome(schema, rng); if (g.pipe.some((op) => op.op === OBS_OP) || g.rank.by === 'obs') plain++; }
  assert.equal(plain, 0, 'the plain schema never does');
  const obs = (oid, eid) => (oid === 'o_coage' ? octx.eval(PROG, eid) : null);
  const g = { seed: { op: 'recent', type: 'paper', days: 3 }, pipe: [{ op: OBS_OP, id: 'o_coage', cmp: 'lt', q: 0.5 }], rank: { by: 'obs', id: 'o_coage' } };
  const base = { memory, vectors: new MemoryVectors(memory), now, value: () => 0.5, k: 10 };
  const withObs = runStrategy(g, { ...base, obs });
  const without = runStrategy(g, base);
  assert.ok(withObs.items.length > 0 && withObs.items.every((it) => /^paper:(x|m)/.test(it.id)), `young pairs only: ${withObs.items.map((x) => x.id)}`);
  assert.ok(without.items.length >= withObs.items.length, 'without ctx.obs the filter passes everything through');
  assert.match(withObs.items[0].rationale[0], /o_coage/);
  assert.equal(genomeId(g), genomeId({ rank: { id: 'o_coage', by: 'obs' }, pipe: [{ q: 0.5, cmp: 'lt', id: 'o_coage', op: OBS_OP }], seed: { days: 3, type: 'paper', op: 'recent' } }));
});

test('additivity: v3 flags emit no v4 events; v4 flags emit them; v3 folds ignore them; a v4 run is reproducible from the log + seed', async () => {
  const plugin = await loadPlugin('./plugins/toy/index.mjs', { seed: 5, epoch: EPOCH }, { baseDir: ROOT });
  const store = await openStore(':memory:');
  for (let i = 0; i < 3; i++) await runOnce({ store, plugin, domain: 'toy', node: 'n', env: { LOAM_AUTONOMOUS: '1' }, now: EPOCH + i * DAY_MS + 1000, seed: `d${i}`, config: { budgetSeconds: 6, ...VARIANT_CONFIGS.v3 } });
  const kinds = new Set((await store.readAll()).map((e) => e.kind));
  for (const k of ['hindsight.labeled', 'observable.proposed', 'observable.adopted', 'observable.retired']) assert.ok(!kinds.has(k), `${k} must not appear with v3 flags`);
  assert.ok(!(await store.readAll({ kinds: ['challenge.created'] })).some((e) => e.body.spec?.retro), 'no retro environments with v3 flags');
  const a = await runVariant({ variant: 'v4-all', runs: 9, budgetSeconds: 8, seed: 3, epoch: EPOCH, judgmentsPerRun: 6, config: { hindsightHorizon: 3 } });
  const b = await runVariant({ variant: 'v4-all', runs: 9, budgetSeconds: 8, seed: 3, epoch: EPOCH, judgmentsPerRun: 6, config: { hindsightHorizon: 3 } });
  const last = a.series.at(-1);
  assert.ok(last.v4.hindRows > 100 && last.v4.labelPairs > 0, JSON.stringify(last.v4));
  assert.ok(last.v4.adopted + last.v4.candidates > 0);
  assert.ok(last.v4.curriculum && last.v4.curriculum.total > 0, 'retro environments exist');
  assert.ok(a.series.some((s) => typeof s.v4.hindCorr === 'number'), 'label-vs-truth correlation is measured on labelled days');
  assert.deepEqual(a.series.map((s) => [s.findings, s.trueValue, s.evaluations, s.v4.hindRows, s.v4.adopted, s.v4.adoptedNames.map((n) => n.id)]), b.series.map((s) => [s.findings, s.trueValue, s.evaluations, s.v4.hindRows, s.v4.adopted, s.v4.adoptedNames.map((n) => n.id)]));
});

test('the shipping v4 configuration is what the experiments say it should be', () => {
  assert.equal(VARIANT_CONFIGS.v4, V4_DEFAULT);
  assert.equal(V4_DEFAULT.valueModel, true);
  assert.ok(V4_KINDS.includes('hindsight.labeled'));
});

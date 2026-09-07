// v3 addon tests: learned behavior space, frontier, value model, credit, sentinel, phenotype,
// and the additivity contract (default flags emit no v3 events; old folds unchanged).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEvent, Clock, makeRng } from '../core/events.mjs';
import { foldEvents } from '../core/projections.mjs';
import { makeVqProjection, vqOccupied, vqElites } from '../core/vq.mjs';
import { makeFrontierProjection, initialChallenges, mutateChallenge, minimalCriterion, regionAccept, challengeFitness, activeChallenges } from '../core/frontier.mjs';
import { makeValueModelProjection, predictValue, selectJudgments, calibrationMae } from '../core/valuemodel.mjs';
import { provenanceProjection, assignCredit, makePlannerCreditProjection } from '../core/credit.mjs';
import { makePlannerProjection } from '../core/planner.mjs';
import { makeSentinelProjection, diagnose, nextIntervention, activeInterventions, interventionEffects } from '../core/sentinel.mjs';
import { phenotypeOf, SignalRanks, euclid } from '../core/phenotype.mjs';
import { memoryProjection, MemoryVectors, DAY_MS } from '../core/memory.mjs';
import { DegreeRanks } from '../core/strategy.mjs';
import { featurize } from '../core/attention.mjs';
import { openStore } from '../core/store.mjs';
import { loadPlugin } from '../core/plugins.mjs';
import { runOnce } from '../core/worker.mjs';
import { runVariant, VARIANT_CONFIGS } from '../core/experiment.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EPOCH = Date.UTC(2026, 0, 1);
const V3_KINDS = ['strategy.phenotype', 'challenge.created', 'challenge.evaluated', 'challenge.retired', 'value.features', 'judgment.requested', 'credit.assigned', 'sentinel.intervened'];

const G = (n) => ({ seed: { op: 'all', type: 'x' }, pipe: Array.from({ length: n }, () => ({ op: 'limit', n: 10 })), rank: { by: 'value' } });
function evs(node, kind, bodies, domain = 'd') {
  const c = new Clock(node, () => 1);
  return bodies.map((body, i) => makeEvent({ node, seq: i + 1, hlc: c.tick(), kind: Array.isArray(kind) ? kind[i] : kind, ts: body.ts ?? 1, domain, body }));
}

test('vq archive: cells are founded on demand, elites compete per cell, curiosity and re-encoding behave', () => {
  const proj = makeVqProjection({ tau: 0.5, kmax: 3, reassignEvery: 100 });
  const p = (x, y) => [x, y, 0, 0];
  const list = evs('q', 'strategy.phenotype', [
    { genomeId: 'a', genome: G(1), fitness: 0.2, phenotype: p(0, 0), fixedCell: '0-0-0', kind: 'random', ts: 1 },
    { genomeId: 'b', genome: G(2), fitness: 0.1, phenotype: p(0.1, 0), fixedCell: '0-0-0', kind: 'mutation', parent: { genomeId: 'a', cell: 'vq:0' }, ts: 2 }, // same cell, worse → curiosity(vq:0) 0
    { genomeId: 'c', genome: G(0), fitness: 0.2, phenotype: p(0.05, 0.05), fixedCell: '0-0-0', kind: 'mutation', parent: { genomeId: 'a', cell: 'vq:0' }, ts: 3 }, // tie, smaller → replaces, curiosity +1
    { genomeId: 'd', genome: G(1), fitness: 0.3, phenotype: p(1, 1), fixedCell: '5-5-5', kind: 'mutation', parent: { genomeId: 'c', cell: 'vq:0' }, ts: 4 }, // far → new cell, curiosity +1
    { genomeId: 'e', genome: G(1), fitness: 0.05, phenotype: p(-1, -1), fixedCell: '1-1-1', kind: 'random', ts: 5 }, // far → new cell (3rd, at kmax)
    { genomeId: 'f', genome: G(1), fitness: 0.4, phenotype: p(3, 3), fixedCell: '5-5-5', kind: 'random', ts: 6 }, // codebook full → tau widens, competes nearest (d) and wins
    { genomeId: 'f', genome: G(1), fitness: 0.35, phenotype: p(3, 3), fixedCell: '5-5-5', kind: 'reevaluate', ts: 7 }, // in-place update
    { genomeId: 'g', genome: G(1), fitness: 0, phenotype: null, fixedCell: null, kind: 'mutation', parent: { genomeId: 'f', cell: 'vq:1' }, ts: 8 }, // no behaviour → −0.5
  ]);
  const { state } = foldEvents(proj, list, { domain: 'd' });
  assert.equal(state.centroids.length, 3);
  assert.equal(vqOccupied(state), 3);
  assert.equal(state.elites.get(0).genomeId, 'c');
  assert.equal(state.elites.get(1).genomeId, 'f');
  assert.equal(state.elites.get(1).fitness, 0.35);
  assert.equal(state.elites.get(1).evals, 2);
  assert.equal(state.curiosity.get('vq:0'), 2);
  assert.equal(state.curiosity.get('vq:1'), 0);
  assert.ok(state.tau > 0.5, 'tau widened when the codebook was full');
  assert.ok(state.denied >= 1, 'far phenotypes at a full codebook are denied a new cell');
  const again = proj.hydrate(JSON.parse(JSON.stringify(proj.dehydrate(state))));
  assert.equal(again.elites.get(0).genomeId, 'c');
  assert.deepEqual(vqElites(again).map((e) => e.cell).sort(), ['vq:0', 'vq:1', 'vq:2']);
  // re-encoding: an elite whose nearest centroid now hosts a fitter one is dropped
  const proj2 = makeVqProjection({ tau: 0.5, kmax: 8, reassignEvery: 2 });
  const l2 = evs('q', 'strategy.phenotype', [
    { genomeId: 'a', genome: G(1), fitness: 0.2, phenotype: p(0, 0), kind: 'random', ts: 1 },
    { genomeId: 'b', genome: G(1), fitness: 0.5, phenotype: p(0.6, 0), kind: 'random', ts: 2 }, // new cell 1 at (0.6,0)
    ...Array.from({ length: 6 }, (_, i) => ({ genomeId: `m${i}`, genome: G(1), fitness: 0.05, phenotype: p(0.2, 0), kind: 'random', ts: 3 + i })), // nearest is cell 0 → pull its centroid toward 0.2
  ]);
  const s2 = foldEvents(proj2, l2, { domain: 'd' }).state;
  assert.ok(s2.centroids[0][0] > 0.1, `centroid drifted: ${s2.centroids[0][0]}`);
  assert.ok(s2.dropped >= 0);
});

test('frontier: challenges are created, evaluated, solved, retired by the minimal criterion; regions filter; fitness needs the bar', () => {
  const schema = { entityTypes: ['paper', 'author'], primaryType: 'paper', relations: [], signals: [] };
  const init = initialChallenges(schema);
  assert.equal(init.length, 3);
  const rng = makeRng(2);
  const harder = mutateChallenge(init[0], rng, schema, { harder: true });
  assert.ok(harder.minValue > init[0].minValue);
  const proj = makeFrontierProjection({ maxElites: 2 });
  const list = evs('f', ['challenge.created', 'challenge.evaluated', 'challenge.evaluated', 'challenge.evaluated', 'challenge.retired', 'challenge.retired'], [
    { challengeId: 'c1', spec: init[0], parent: null, origin: 'schedule', ts: 1 },
    { challengeId: 'c1', genomeId: 'g1', genome: G(1), fitness: 0.1, kind: 'random', ts: 2 },
    { challengeId: 'c1', genomeId: 'g2', genome: G(1), fitness: 0.3, kind: 'transfer-in', ts: 3 },
    { challengeId: 'c1', genomeId: 'g3', genome: G(1), fitness: 0.2, kind: 'mutation', ts: 4 },
    { challengeId: 'c1', reason: 'solved', ts: 5 },
    { challengeId: 'c1', reason: 'impossible', ts: 6 }, // ignored: already terminal
  ]);
  const { state } = foldEvents(proj, list, { domain: 'd' });
  const ch = state.challenges.get('c1');
  assert.equal(ch.evaluations, 3); assert.equal(ch.best, 0.3); assert.equal(ch.bestGenomeId, 'g2');
  assert.deepEqual(ch.elites.map((e) => e.genomeId), ['g2', 'g3'], 'top elites kept, capped');
  assert.equal(ch.status, 'solved'); assert.equal(state.solved, 1); assert.equal(state.transfers, 1);
  assert.equal(activeChallenges(state).length, 0);
  assert.equal(minimalCriterion({ status: 'active', evaluations: 25, best: 0.005 }), 'impossible');
  assert.equal(minimalCriterion({ status: 'active', evaluations: 3, best: 0.005 }), 'active');
  assert.equal(minimalCriterion({ status: 'active', evaluations: 3, best: 0.5 }), 'solved');
  assert.equal(minimalCriterion({ status: 'active', evaluations: 100, best: 0.1 }), 'stale');
  const memory = memoryProjection.init();
  memory.entities.set('paper:a', { id: 'paper:a', type: 'paper', firstSeen: 1000 - 10 * DAY_MS });
  memory.entities.set('author:b', { id: 'author:b', type: 'author', firstSeen: 1000 - 10 * DAY_MS });
  memory.entities.set('paper:c', { id: 'paper:c', type: 'paper', firstSeen: 1000 });
  const accept = regionAccept({ minValue: 0.4, region: { type: 'paper', ageMin: 7, ageMax: null } }, memory, 1000);
  assert.deepEqual(['paper:a', 'author:b', 'paper:c', 'nope'].map(accept), [true, false, false, false]);
  const f = [{ value: 0.6, novelty: 1 }, { value: 0.3, novelty: 1 }];
  assert.ok(Math.abs(challengeFitness(f, 10, G(0), { minValue: 0.5 }) - (0.6 / 10 - 0.004)) < 1e-9);
});

test('value model: learns residuals from judgments, resolves late features, selects informative judgments, tracks calibration', () => {
  const proj = makeValueModelProjection({ dim: 64, priorVar: 0.25, noiseVar: 0.05 });
  const feats = (kind) => ({ 'type=paper': 1, [`kind=${kind}`]: 1 });
  const bodies = [];
  const kinds = [];
  // 12 judged entities: kind A is systematically under-valued by the plug-in (+0.4), kind B over-valued (−0.3)
  for (let i = 0; i < 12; i++) {
    const kind = i % 2 ? 'A' : 'B';
    bodies.push({ entityId: `paper:${i}`, features: feats(kind), pluginScore: 0.3, ts: i }); kinds.push('value.features');
    bodies.push({ entityId: `paper:${i}`, value: kind === 'A' ? 0.7 : 0.05, by: 'oracle', ts: i }); kinds.push('judgment.recorded');
  }
  // a judgment that arrives BEFORE its features
  bodies.push({ entityId: 'paper:late', value: 0.9, by: 'oracle', ts: 50 }); kinds.push('judgment.recorded');
  bodies.push({ entityId: 'paper:late', features: feats('A'), pluginScore: 0.3, ts: 51 }); kinds.push('value.features');
  const { state } = foldEvents(proj, evs('v', kinds, bodies), { domain: 'd' });
  assert.equal(state.trained, 13);
  assert.equal(state.pending.size, 0);
  const pa = predictValue(state, feats('A'), 0.3), pb = predictValue(state, feats('B'), 0.3);
  assert.ok(pa.value > 0.55 && pb.value < 0.15, `A→${pa.value} B→${pb.value}`);
  assert.ok(pa.sd < 0.25);
  const unseen = predictValue(state, { 'type=paper': 1, 'kind=Z': 1 }, 0.3);
  assert.ok(unseen.ig > pa.ig, 'unseen feature combination is more informative');
  const cands = [
    { entityId: 'paper:0', features: feats('B'), pluginScore: 0.3, score: 0.9 }, // already judged → skipped
    { entityId: 'paper:x', features: feats('A'), pluginScore: 0.3, score: 0.5 },
    { entityId: 'paper:y', features: { 'type=paper': 1, 'kind=Z': 1 }, pluginScore: 0.3, score: 0.5 },
    { entityId: 'paper:z', features: { 'type=paper': 1, 'kind=Z': 1 }, pluginScore: 0.3, score: 0.1 },
  ];
  const picked = selectJudgments(state, cands, { k: 2, mode: 'ig' });
  assert.deepEqual(picked.map((c) => c.entityId), ['paper:y', 'paper:z'], 'unjudged, most informative, relevance-weighted');
  const ei = selectJudgments(state, cands, { k: 2, mode: 'ei', cutoff: 0.5 });
  assert.equal(ei[0].entityId, 'paper:x', 'EI: the confidently-high item beats uncertain low ones over a 0.5 cutoff');
  assert.ok(ei.every((c) => c.priority >= 0));
  assert.ok(calibrationMae(state) > 0 && calibrationMae(state) < 0.5);
  const again = proj.hydrate(JSON.parse(JSON.stringify(proj.dehydrate(state))));
  assert.equal(predictValue(again, feats('A'), 0.3).value, pa.value);
});

test('credit: provenance folds contributors; credit sums to the finding score; the credit planner equals the v2 planner on a v2 log', () => {
  const obs = (i, sensor, params, entities, t) => ({ sensor, externalId: `e${i}`, observedAt: t, params, entities: entities.map((k) => ({ type: 'paper', key: k })), relations: [] });
  const kinds = ['observation.seen', 'observation.seen', 'observation.seen', 'action.outcome', 'action.outcome', 'run.completed'];
  const bodies = [
    obs(1, 'feed', 'topic=t1', ['a', 'b'], 1000), obs(2, 'author', 'author=x', ['a'], 1000 - 20 * DAY_MS), obs(3, 'feed', 'topic=t2', ['c'], 1000),
    { type: 'poll:feed', sensor: 'feed', paramsKey: 'topic=t1', features: { type: 'poll', sensor: 'feed', topic: 't1' }, raw: 2, ms: 100, ts: 1000 },
    { type: 'poll:author', sensor: 'author', paramsKey: 'author=x', features: { type: 'poll', sensor: 'author' }, raw: 1, ms: 100, ts: 1000 },
    { runId: 'r' },
  ];
  const list = evs('p', kinds, bodies);
  const prov = foldEvents(provenanceProjection, list, { domain: 'd' }).state;
  assert.deepEqual(prov.byEntity.get('paper:a').map((c) => c.key).sort(), ['author|author=x', 'feed|topic=t1']);
  assert.ok(prov.lastFeatures.get('feed|topic=t1').features.topic === 't1');
  const memory = memoryProjection.init();
  memory.entities.set('paper:a', { id: 'paper:a', type: 'paper' });
  memory.out.set('paper:a', new Map([['cites', new Set(['paper:c'])]]));
  const credits = assignCredit({ entityId: 'paper:a', score: 0.8 }, { provenance: prov, memory, now: 1000, hops: 1 });
  const total = credits.reduce((s, c) => s + c.amount, 0);
  assert.ok(Math.abs(total - 0.8) < 1e-3, `credit sums to score: ${total}`);
  const direct = credits.find((c) => c.paramsKey === 'topic=t1'), hist = credits.find((c) => c.paramsKey === 'author=x'), nbr = credits.find((c) => c.paramsKey === 'topic=t2');
  assert.ok(direct.amount > hist.amount, 'older observations get less (recency decay)');
  assert.ok(nbr && nbr.hops === 1 && nbr.amount < direct.amount, 'neighbour contributors get a lower weight');
  assert.ok(direct.features && direct.type === 'poll:feed');
  // planner equivalence on a log without credit events
  const base = foldEvents(makePlannerProjection(), list, { domain: 'd' }).state;
  const withCredit = foldEvents(makePlannerCreditProjection(), list, { domain: 'd' }).state;
  const phi = featurize({ type: 'poll', sensor: 'feed', topic: 't1' }, base.model.dim);
  assert.equal(base.model.mean(phi), withCredit.model.mean(phi));
  assert.equal(base.outcomes, withCredit.outcomes);
  assert.equal(withCredit.credited, 0);
  // and it moves once credit arrives
  const creditEv = evs('p2', 'credit.assigned', [{ sensor: 'feed', paramsKey: 'topic=t1', amount: 0.6, weight: 1, hops: 0, features: { type: 'poll', sensor: 'feed', topic: 't1' }, type: 'poll:feed', ts: 2000 }]);
  const after = foldEvents(makePlannerCreditProjection(), [...list, ...creditEv], { domain: 'd' }).state;
  assert.notEqual(after.model.mean(phi), withCredit.model.mean(phi), 'credit is an extra observation under the poll\'s features');
  assert.equal(after.credited, 1);
  assert.equal(after.credits.get('feed|topic=t1'), 0.6);
  assert.equal(after.scales.get('credit:poll:feed'), 0.6, 'credit keeps its own running scale');
  const phiOther = featurize({ type: 'poll', sensor: 'feed', topic: 't9' }, base.model.dim);
  const gain = after.model.mean(phi) - after.model.mean(phiOther);
  assert.ok(gain > 0, 'the credited feed is preferred over an uncredited sibling');
});

test('sentinel: warms up, detects stagnation from three signals, rotates interventions with cooldown, measures effects', () => {
  const proj = makeSentinelProjection();
  const mk = (i, vps, cells, nv) => ({ runId: `r${i}`, valuePerSecond: vps, novelValue: nv, coverage: cells / 216, archiveCells: cells, findings: 20, startedAt: i });
  const rising = Array.from({ length: 14 }, (_, i) => mk(i, 0.1 + 0.05 * i, 5 + i, 5 + i));
  let state = foldEvents(proj, evs('s', 'run.completed', rising), { domain: 'd' }).state;
  assert.equal(diagnose(state).stagnant, false);
  assert.equal(diagnose(foldEvents(proj, evs('s', 'run.completed', rising.slice(0, 5)), { domain: 'd' }).state).reason, 'warming-up');
  const flat = [...rising, ...Array.from({ length: 10 }, (_, i) => mk(20 + i, 0.5 - 0.01 * i, 19, 12 - 0.5 * i))];
  state = foldEvents(proj, evs('s', 'run.completed', flat), { domain: 'd' }).state;
  const d = diagnose(state);
  assert.equal(d.stagnant, true);
  assert.ok(d.reasons.includes('value-per-second-flat') && d.reasons.includes('archive-saturated') && d.reasons.includes('novel-value-decaying'), d.reasons.join());
  const first = nextIntervention(state);
  assert.equal(first.action, 'temperature');
  const intervention = { runId: 'x', action: 'temperature', params: first.params, ttlRuns: 4, trigger: d, ts: 99 };
  const withOne = foldEvents(proj, evs('s', [...flat.map(() => 'run.completed'), 'sentinel.intervened'], [...flat, intervention]), { domain: 'd' }).state;
  assert.equal(activeInterventions(withOne).length, 1);
  assert.equal(nextIntervention(withOne), null, 'cooldown / active');
  const after = Array.from({ length: 8 }, (_, i) => mk(40 + i, 0.6, 22, 14));
  const later = foldEvents(proj, evs('s', [...flat.map(() => 'run.completed'), 'sentinel.intervened', ...after.map(() => 'run.completed')], [...flat, intervention, ...after]), { domain: 'd' }).state;
  assert.equal(activeInterventions(later).length, 0);
  assert.equal(nextIntervention(later).action, 'frontier', 'rotation');
  const fx = interventionEffects(later);
  assert.equal(fx.length, 1); assert.ok(fx[0].valueAfter > fx[0].valueBefore && fx[0].complete);
});

test('phenotype: stable dimensionality per schema, bounded entries, distinct outputs → distinct vectors', () => {
  const T0 = Date.UTC(2026, 0, 1);
  const c = new Clock('m', () => 1); let seq = 0;
  const list = [];
  for (let d = 0; d < 6; d++) for (let j = 0; j < 4; j++) {
    const key = `p${d}-${j}`, topics = [`t${j % 2}`];
    list.push(makeEvent({ node: 'm', seq: ++seq, hlc: c.tick(), kind: 'observation.seen', ts: T0 + d * DAY_MS, domain: 'd', dedupKey: `o:${key}`, body: { sensor: 's', externalId: key, observedAt: T0 + d * DAY_MS, text: `alpha${j} beta${d} gamma`, entities: [{ type: 'paper', key, text: `alpha${j} beta${d} gamma`, signals: { cites: d * j } }, ...topics.map((t) => ({ type: 'topic', key: t }))], relations: topics.map((t) => ({ from: `paper:${key}`, rel: 'in_topic', to: `topic:${t}` })) } }));
  }
  const memory = foldEvents(memoryProjection, list, { domain: 'd' }).state;
  const schema = { entityTypes: ['paper', 'topic'], primaryType: 'paper', relations: [{ rel: 'in_topic', from: 'paper', to: 'topic' }], signals: [{ name: 'cites', type: 'paper' }] };
  const now = T0 + 6 * DAY_MS;
  const ctx = { memory, vectors: new MemoryVectors(memory), now, schema, degreeRanks: new DegreeRanks(memory), signalRanks: new SignalRanks(memory, schema.signals) };
  const a = phenotypeOf([{ id: 'paper:p5-0' }, { id: 'paper:p5-1' }], { ...ctx, findings: [{ entityId: 'paper:p5-0', value: 0.9, novelty: 1 }] });
  const b = phenotypeOf([{ id: 'paper:p0-0' }, { id: 'topic:t0' }], { ...ctx, findings: [] });
  assert.equal(a.dim, b.dim);
  assert.equal(a.dim, 2 + 4 + 4 + 1 + 3 + 2 + 1 + 1 + 8);
  assert.ok(a.vec.every((x) => x >= -1 && x <= 1));
  assert.ok(euclid(a.vec, b.vec) > 0.3, 'fresh papers vs old paper+topic differ');
  assert.equal(phenotypeOf([], ctx), null);
  assert.equal(ctx.signalRanks.percentile('paper', 'cites', 100), 1);
});

test('additivity: default flags emit no v3 events; the v3 event stream is folded by v3 projections only', async () => {
  const plugin = await loadPlugin('./plugins/toy/index.mjs', { seed: 5, epoch: EPOCH }, { baseDir: ROOT });
  const store = await openStore(':memory:');
  for (let i = 0; i < 3; i++) await runOnce({ store, plugin, domain: 'toy', node: 'n', env: { LOAM_AUTONOMOUS: '1' }, now: EPOCH + i * DAY_MS + 1000, seed: `d${i}`, config: { budgetSeconds: 6 } });
  const kinds = new Set((await store.readAll()).map((e) => e.kind));
  for (const k of V3_KINDS) assert.ok(!kinds.has(k), `${k} must not appear with default flags`);
  const store3 = await openStore(':memory:');
  let last;
  for (let i = 0; i < 4; i++) last = await runOnce({ store: store3, plugin, domain: 'toy', node: 'n', env: { LOAM_AUTONOMOUS: '1' }, now: EPOCH + i * DAY_MS + 1000, seed: `v${i}`, config: { budgetSeconds: 8, ...VARIANT_CONFIGS['v3-all'], sentinelMinRuns: 2, sentinelWindow: 2, judgmentsPerRun: 3 } });
  const k3 = new Set((await store3.readAll()).map((e) => e.kind));
  for (const k of ['strategy.phenotype', 'challenge.created', 'challenge.evaluated', 'value.features', 'judgment.requested', 'credit.assigned']) assert.ok(k3.has(k), `${k} emitted with v3 flags`);
  assert.ok(last.summary.vq.cells > 0 && last.summary.frontier.active > 0 && last.summary.valueModel.requested > 0 && last.summary.credit.credited > 0, JSON.stringify({ vq: last.summary.vq, fr: last.summary.frontier, vm: last.summary.valueModel, cr: last.summary.credit }));
  // the v2 projections' state on the v3 log ignores the new kinds (fixed archive counts only strategy.evaluated)
  const { qdProjection } = await import('../core/qd.mjs');
  const evald = (await store3.readAll({ domain: 'toy', kinds: ['strategy.evaluated'] })).length;
  const { project } = await import('../core/projections.mjs');
  const q = await project(store3, qdProjection, { domain: 'toy', useSnapshot: false, saveSnapshot: false });
  assert.equal(q.state.evaluations, evald);
});

test('v3 experiment plumbing (slow-ish): oracle judgments flow, addons produce their metrics over a short run', async () => {
  const r = await runVariant({ variant: 'v3-all', runs: 6, budgetSeconds: 8, seed: 3, epoch: EPOCH, judgmentsPerRun: 4, config: { sentinelMinRuns: 3, sentinelWindow: 3 } });
  const last = r.series.at(-1);
  assert.ok(last.judged >= 12, `judgments ingested: ${last.judged}`);
  assert.ok(last.vmTrained >= 8, `value model trained: ${last.vmTrained}`);
  assert.ok(last.vqCells > 0 && last.challenges && last.challenges.active >= 1 && last.credited > 0, JSON.stringify(last));
  assert.ok(last.cumTrue > 0 && typeof last.calibMae === 'number');
});

test('the shipping v3 configuration is what the experiments say it should be', () => {
  assert.deepEqual(VARIANT_CONFIGS.v3, { descriptor: 'both', valueModel: true, judgmentsPerRun: 10, sentinel: 'observe', frontier: false, credit: false });
  assert.equal(VARIANT_CONFIGS['v3-all'].frontier, true);
});

test('vmSearch modes: judgments reach delivery in every mode, but search sees them only in override/posterior', async () => {
  const { Ledger } = await import('../core/ledger.mjs');
  const { Policy } = await import('../policy/policy.mjs');
  const { archiveProjection } = await import('../core/archive.mjs');
  const { project } = await import('../core/projections.mjs');
  const plugin = await loadPlugin('./plugins/toy/index.mjs', { seed: 5, epoch: EPOCH }, { baseDir: ROOT });
  for (const mode of ['proxy', 'override', 'posterior']) {
    const store = await openStore(':memory:');
    const cfg = { budgetSeconds: 8, valueModel: true, descriptor: 'both', judgmentsPerRun: 6, vmMinTrained: 1, vmSearch: mode };
    const r1 = await runOnce({ store, plugin, domain: 'toy', node: 'n', env: { LOAM_AUTONOMOUS: '1' }, now: EPOCH + 1000, seed: 'a', config: cfg });
    // the operator judges an undelivered pool item very high
    const delivered = new Set(r1.findings.map((f) => f.entityId));
    const target = r1.pool.find((p) => !delivered.has(p.entityId) && p.entityId.startsWith('paper:'));
    assert.ok(target, 'an undelivered candidate exists');
    const ledger = await new Ledger({ store, node: 'op', policy: new Policy({}, { env: {} }), domain: 'toy', now: () => EPOCH + 2000 }).init();
    await ledger.emit('value.features', { runId: r1.summary.runId, entityId: target.entityId, features: { 'type=paper': 1 }, pluginScore: target.value, ts: EPOCH + 2000 });
    await ledger.emit('judgment.recorded', { entityId: target.entityId, value: 0.95, by: 'op', ts: EPOCH + 2000 });
    const r2 = await runOnce({ store, plugin, domain: 'toy', node: 'n', env: { LOAM_AUTONOMOUS: '1' }, now: EPOCH + DAY_MS + 1000, seed: 'b', config: cfg });
    const f = r2.findings.find((x) => x.entityId === target.entityId);
    assert.ok(f, `${mode}: a judged-high novel entity is delivered (judgment seeds)`);
    assert.ok(f.value > target.value, `${mode}: its delivery value reflects the judgment`);
    const arch = (await project(store, archiveProjection, { domain: 'toy', saveSnapshot: false })).state;
    assert.equal(arch.judgments.get(target.entityId).value, 0.95);
  }
});

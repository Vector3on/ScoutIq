import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinearModel, featurize, selectActions, cholesky, choleskySolve, bucket } from '../core/attention.mjs';
import { makeRng } from '../core/events.mjs';
import { foldEvents } from '../core/projections.mjs';
import { makePlannerProjection } from '../core/planner.mjs';
import { makeEvent, Clock } from '../core/events.mjs';

test('cholesky solves SPD systems', () => {
  const A = Float64Array.from([4, 2, 2, 3]);
  const L = cholesky(A, 2);
  const x = choleskySolve(L, 2, Float64Array.from([2, 1]));
  assert.ok(Math.abs(4 * x[0] + 2 * x[1] - 2) < 1e-9 && Math.abs(2 * x[0] + 3 * x[1] - 1) < 1e-9);
});

test('posterior mean matches the closed form; information gain is exact and shrinks with evidence; forgetting regrows it', () => {
  const m = new LinearModel({ dim: 8, priorVar: 2, noiseVar: 0.5 });
  const phi = [[0, 1], [3, 1]]; // bias + one feature
  const ig0 = m.infoGain(phi);
  assert.ok(Math.abs(ig0 - 0.5 * Math.log(1 + (2 + 2) / 0.5)) < 1e-9, 'IG = ½log(1+φᵀΣφ/σn²) with Σ = σ0²I initially');
  for (let i = 0; i < 10; i++) m.update(phi, 1.0);
  // closed form for w on the two active dims: Λ = I/σ0² + n φφᵀ/σn², b = n φ y/σn²
  const n = 10, p0 = 1 / 2, inv = 1 / 0.5;
  const a = p0 + n * inv, bb = n * inv; // Λ = [[a, bb],[bb, a]], b = [n*inv, n*inv]
  const det = a * a - bb * bb;
  const mu = ((a - bb) * n * inv) / det;
  assert.ok(Math.abs(m.mean(phi) - 2 * mu) < 1e-9, `mean ${m.mean(phi)} vs ${2 * mu}`);
  const ig1 = m.infoGain(phi);
  assert.ok(ig1 < ig0 / 5, `IG shrinks: ${ig0} → ${ig1}`);
  m.forget();
  assert.ok(m.infoGain(phi) > ig1, 'forgetting regrows uncertainty');
  const other = [[0, 1], [5, 1]];
  assert.ok(m.infoGain(other) > m.infoGain(phi), 'unobserved features carry more information');
  const s = m.toState(); const m2 = LinearModel.fromState(s);
  assert.equal(m2.mean(phi), m.mean(phi));
});

test('Thompson sampling with IG picks the better arm and explores the unknown one', () => {
  const m = new LinearModel({ dim: 32, priorVar: 1, noiseVar: 0.1 });
  const A = featurize({ type: 'poll', sensor: 'a' }, 32), B = featurize({ type: 'poll', sensor: 'b' }, 32);
  for (let i = 0; i < 30; i++) { m.update(A, 0.8); m.update(B, 0.2); }
  const rng = makeRng(9);
  let a = 0, b = 0, c = 0;
  const cands = [{ id: 'A', features: { type: 'poll', sensor: 'a' }, cost: 1 }, { id: 'B', features: { type: 'poll', sensor: 'b' }, cost: 1 }, { id: 'C', features: { type: 'poll', sensor: 'c' }, cost: 1 }];
  for (let i = 0; i < 300; i++) {
    const r = selectActions(cands, { model: m, rng, budget: 1, beta: 0.3 });
    if (r.chosen[0].id === 'A') a++; if (r.chosen[0].id === 'B') b++; if (r.chosen[0].id === 'C') c++;
  }
  assert.ok(a > 120 && a > b * 5, `A chosen ${a}/300, B ${b}/300`);
  assert.ok(c > 20, `unknown arm C explored ${c}/300`);
  assert.equal(featurize({}, 8)[0][0], 0, 'bias feature present');
});

test('budgeted selection respects the budget and the complementarity reserve', () => {
  const m = new LinearModel({ dim: 32 });
  const rng = makeRng(1);
  const cands = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `poll${i}`, type: 'poll', features: { type: 'poll', i }, cost: 1 })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `evo${i}`, type: 'evolve', features: { type: 'evolve', i }, cost: 0.5 })),
  ];
  const r = selectActions(cands, { model: m, rng, budget: 4, reserve: [{ match: (c) => c.type === 'poll', fraction: 0.3 }, { match: (c) => c.type !== 'poll', fraction: 0.3 }] });
  assert.ok(r.used <= 4 + 1e-9);
  assert.ok(r.chosen.some((c) => c.type === 'poll') && r.chosen.some((c) => c.type === 'evolve'));
  const r2 = selectActions([{ id: 'big', features: {}, cost: 100 }], { model: m, rng, budget: 1 });
  assert.equal(r2.chosen.length, 1, 'always at least one action');
  assert.equal(bucket(5, [1, 3, 10]), 'b2');
});

test('planner projection folds outcomes with per-type scaling and forgets on run boundaries', () => {
  const c = new Clock('p', () => 1); let seq = 0;
  const ev = (kind, body) => makeEvent({ node: 'p', seq: ++seq, hlc: c.tick(), kind, ts: 1, domain: 'd', body });
  const evs = [
    ev('action.outcome', { type: 'poll:x', features: { type: 'poll', sensor: 'x' }, raw: 4, ms: 500, sensor: 'x', paramsKey: 'k', obs: 4, newObs: 4 }),
    ev('action.outcome', { type: 'poll:x', features: { type: 'poll', sensor: 'x' }, raw: 2, ms: 300, sensor: 'x', paramsKey: 'k', obs: 4, newObs: 2 }),
    ev('run.completed', { runId: 'r' }),
  ];
  const proj = makePlannerProjection();
  const { state } = foldEvents(proj, evs, { domain: 'd' });
  assert.equal(state.outcomes, 2); assert.equal(state.runs, 1);
  assert.ok(Math.abs(state.scales.get('poll:x') - 4 * 0.995) < 1e-9);
  const st = state.sensorStats.get('x').get('k');
  assert.equal(st.polls, 2); assert.equal(st.newObs, 6);
  assert.ok(Math.abs(st.lastY - 0.5) < 1e-9, 'second outcome normalised by the running scale');
  const again = proj.hydrate(JSON.parse(JSON.stringify(proj.dehydrate(state))));
  assert.equal(again.model.mean(featurize({ type: 'poll', sensor: 'x' }, again.model.dim)), state.model.mean(featurize({ type: 'poll', sensor: 'x' }, state.model.dim)));
});

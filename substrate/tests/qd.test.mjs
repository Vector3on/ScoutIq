import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qdProjection, coverage, qdScore, fitnessOf, PARSIMONY } from '../core/qd.mjs';
import { foldEvents } from '../core/projections.mjs';
import { makeEvent, Clock } from '../core/events.mjs';

const c = new Clock('q', () => 1);
let seq = 0;
const ev = (body) => makeEvent({ node: 'q', seq: ++seq, hlc: c.tick(), kind: 'strategy.evaluated', ts: body.ts ?? 1, domain: 'd', body: { bins: 6, ...body } });
const G = (n) => ({ seed: { op: 'all', type: 'x' }, pipe: Array.from({ length: n }, () => ({ op: 'limit', n: 10 })), rank: { by: 'value' } });

test('MAP-Elites archive: keep the best per cell, prefer smaller on ties, honest re-evaluation, curiosity bookkeeping', () => {
  const evs = [
    ev({ genomeId: 'g1', genome: G(2), fitness: 0.2, bd: { age: 0.1, centrality: 0.1, spread: 0.1 }, cell: '0-0-0', kind: 'random', ts: 1 }),
    ev({ genomeId: 'g2', genome: G(1), fitness: 0.1, bd: { age: 0.1, centrality: 0.1, spread: 0.1 }, cell: '0-0-0', kind: 'mutation', parent: { genomeId: 'g1', cell: '0-0-0' }, ts: 2 }), // worse → curiosity −0.5 → 0 floor
    ev({ genomeId: 'g3', genome: G(1), fitness: 0.2, bd: { age: 0.1, centrality: 0.1, spread: 0.1 }, cell: '0-0-0', kind: 'mutation', parent: { genomeId: 'g1', cell: '0-0-0' }, ts: 3 }), // tie, smaller → replaces, curiosity +1
    ev({ genomeId: 'g4', genome: G(3), fitness: 0.5, bd: { age: 0.9, centrality: 0.9, spread: 0.9 }, cell: '5-5-5', kind: 'mutation', parent: { genomeId: 'g3', cell: '0-0-0' }, ts: 4 }), // new cell → +1
    ev({ genomeId: 'g4', genome: G(3), fitness: 0.3, bd: { age: 0.9, centrality: 0.9, spread: 0.9 }, cell: '5-5-5', kind: 'reevaluate', ts: 5 }), // elite decays in place
    ev({ genomeId: 'g5', genome: G(0), fitness: 0, bd: null, cell: null, kind: 'random', parent: { genomeId: 'g4', cell: '5-5-5' }, ts: 6 }), // no behavior → not archived, parent −0.5 → 0
  ];
  const { state } = foldEvents(qdProjection, evs, { domain: 'd' });
  assert.equal(state.cells.size, 2);
  assert.equal(state.cells.get('0-0-0').genomeId, 'g3');
  assert.equal(state.cells.get('5-5-5').fitness, 0.3);
  assert.equal(state.cells.get('5-5-5').evals, 2);
  assert.equal(state.curiosity.get('0-0-0'), 2);
  assert.equal(state.curiosity.get('5-5-5'), 0);
  assert.equal(state.evaluations, 6);
  assert.equal(state.elitesReplaced, 3);
  assert.equal(state.genomes.get('g4').evals, 2);
  assert.equal(coverage(state), 2 / 216);
  assert.equal(Number(qdScore(state).toFixed(3)), 0.5);
  // dehydrate/hydrate round trip
  const again = qdProjection.hydrate(JSON.parse(JSON.stringify(qdProjection.dehydrate(state))));
  assert.equal(again.cells.get('0-0-0').genomeId, 'g3');
  assert.equal(again.curiosity.get('0-0-0'), 2);
});

test('fitness is novel value with parsimony pressure', () => {
  const f = [{ value: 1, novelty: 1 }, { value: 0.5, novelty: 0 }, { value: 0.5, novelty: 0.5 }];
  assert.equal(Number(fitnessOf(f, 10, G(1)).toFixed(6)), Number(((1 + 0 + 0.25) / 10 - PARSIMONY * 2).toFixed(6)));
  assert.ok(fitnessOf(f, 10, G(4)) < fitnessOf(f, 10, G(0)));
});

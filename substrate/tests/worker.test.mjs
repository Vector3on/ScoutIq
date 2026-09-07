// The falsification protocol, run as tests. If these fail, the thesis is wrong
// (or the toy is): see DESIGN.md §6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runExperiment, runVariant, spearman } from '../core/experiment.mjs';
import { openStore } from '../core/store.mjs';
import { loadPlugin } from '../core/plugins.mjs';
import { runOnce } from '../core/worker.mjs';
import { project } from '../core/projections.mjs';
import { memoryProjection } from '../core/memory.mjs';
import { archiveProjection } from '../core/archive.mjs';
import { qdProjection } from '../core/qd.mjs';
import { makePlannerProjection } from '../core/planner.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EPOCH = Date.UTC(2026, 0, 1);
const DAY = 86400000;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

test('compounding + open-endedness (slow): persistent state beats the memoryless ablation on hidden truth; QD keeps illuminating', async () => {
  const runs = 10, seeds = [7, 11, 23];
  const late = { memory: [], memoryless: [], 'single-cell': [] };
  const perSeed = [];
  for (const seed of seeds) {
    const { results, verdicts } = await runExperiment({ runs, budgetSeconds: 8, seed, variants: ['memory', 'memoryless', 'single-cell'], epoch: EPOCH });
    for (const v of Object.keys(late)) late[v].push(mean(results[v].slice(runs / 2).map((r) => r.trueValue)));
    perSeed.push(verdicts);
  }
  const ratio = mean(late.memory) / Math.max(1e-6, mean(late.memoryless));
  const detail = JSON.stringify(perSeed.map((v) => ({ mm: v.memoryVsMemoryless, adv: v.advantageTrend, ill: [v.illuminatedMemory, v.illuminatedSingle], prod: [v.productiveMemory, v.productiveSingle], ent: v.lateEntropy, nov: v.lateNovelty, minF: v.minFindings })));
  // compounding: paired late-run advantage on hidden truth, aggregated over seeds; a majority of seeds individually ahead
  assert.ok(ratio > 1.15, `memory/memoryless late true value = ${ratio.toFixed(3)} ${detail}`);
  assert.ok(perSeed.filter((v) => v.memoryVsMemoryless > 1).length >= 2, `per-seed ratios ${detail}`);
  assert.ok(perSeed.reduce((s, v) => s + v.hitsMemory, 0) > perSeed.reduce((s, v) => s + v.hitsMemoryless, 0), `more true hits with memory ${detail}`);
  // open-endedness: every run delivers, novelty stays high, no collapse to one way of looking
  assert.ok(perSeed.every((v) => v.openEnded), `open-ended on every seed ${detail}`);
  assert.ok(mean(perSeed.map((v) => v.lateEntropy)) >= 1, `strategy entropy ${detail}`);
  // QD: illuminates more behaviour space than a single-elite archive, at no cost in value
  assert.ok(mean(perSeed.map((v) => v.illuminatedMemory)) > mean(perSeed.map((v) => v.illuminatedSingle)), `illumination ${detail}`);
  assert.ok(mean(late.memory) >= 0.9 * mean(late['single-cell']), `QD is not worse on value: ${mean(late.memory)} vs ${mean(late['single-cell'])}`);
});

test('stigmergy: a poll claimed by another worker (lease in the shared log) is skipped', async () => {
  const store = await openStore(':memory:');
  const plugin = await loadPlugin('./plugins/toy/index.mjs', { seed: 3, epoch: EPOCH }, { baseDir: ROOT });
  const { Ledger } = await import('../core/ledger.mjs');
  const { Policy } = await import('../policy/policy.mjs');
  const other = await new Ledger({ store, node: 'other.worker', policy: new Policy({}, { env: {} }), domain: 'toy', now: () => EPOCH + 500 }).init();
  await other.emit('task.claimed', { key: 'toy-feed:topic=t0', node: 'other.worker', until: Date.now() + 3600e3 }); // leases are wall-clock: they guard concurrent workers
  const res = await runOnce({ store, plugin, domain: 'toy', node: 'test.node', env: { LOAM_AUTONOMOUS: '1' }, now: EPOCH + 1000, seed: 's', config: { budgetSeconds: 30 } });
  const outcomes = (await store.readAll({ domain: 'toy', kinds: ['action.outcome'] })).map((e) => e.body);
  assert.ok(outcomes.some((o) => o.paramsKey === 'topic=t1'), 'other feeds polled');
  assert.ok(!outcomes.some((o) => o.paramsKey === 'topic=t0'), 'claimed feed skipped');
  const claims = (await store.readAll({ domain: 'toy', kinds: ['task.claimed'] })).map((e) => e.body);
  assert.ok(claims.some((c) => c.node === 'test.node' && c.key === 'toy-feed:topic=t1'), 'this worker published its own leases');
  assert.ok(res.summary.executed > 0);
});

test('runs are reproducible from the log + seed, and live projections equal a from-scratch replay', async () => {
  const a = await runVariant({ variant: 'memory', runs: 3, budgetSeconds: 6, seed: 5, epoch: EPOCH });
  const b = await runVariant({ variant: 'memory', runs: 3, budgetSeconds: 6, seed: 5, epoch: EPOCH });
  assert.deepEqual(a.series.map((s) => [s.findings, s.trueValue, s.coverage, s.evaluations, s.newObs]), b.series.map((s) => [s.findings, s.trueValue, s.coverage, s.evaluations, s.newObs]));
  const store = await openStore(':memory:');
  const plugin = await loadPlugin('./plugins/toy/index.mjs', { seed: 3, epoch: EPOCH }, { baseDir: ROOT });
  let last;
  for (let i = 0; i < 3; i++) last = await runOnce({ store, plugin, domain: 'toy', node: 'test.node', env: { LOAM_AUTONOMOUS: '1' }, now: EPOCH + i * DAY + 1000, seed: `s${i}`, config: { budgetSeconds: 6 } });
  const snap = { m: await project(store, memoryProjection, { domain: 'toy' }), a: await project(store, archiveProjection, { domain: 'toy' }), q: await project(store, qdProjection, { domain: 'toy' }), p: await project(store, makePlannerProjection(), { domain: 'toy' }) };
  const fresh = { m: await project(store, memoryProjection, { domain: 'toy', useSnapshot: false, saveSnapshot: false }), a: await project(store, archiveProjection, { domain: 'toy', useSnapshot: false, saveSnapshot: false }), q: await project(store, qdProjection, { domain: 'toy', useSnapshot: false, saveSnapshot: false }), p: await project(store, makePlannerProjection(), { domain: 'toy', useSnapshot: false, saveSnapshot: false }) };
  assert.equal(snap.m.applied, 0, 'snapshot written by the worker is current');
  assert.equal(snap.m.state.entities.size, fresh.m.state.entities.size);
  assert.equal(snap.m.state.obsCount, fresh.m.state.obsCount);
  assert.equal(snap.a.state.total, fresh.a.state.total);
  assert.equal(snap.a.state.total, last.summary.findings + (await store.readAll({ domain: 'toy', kinds: ['finding.emitted'] })).length - last.summary.findings);
  assert.deepEqual([...snap.q.state.cells.keys()].sort(), [...fresh.q.state.cells.keys()].sort());
  assert.equal(snap.p.state.outcomes, fresh.p.state.outcomes);
  assert.equal(last.summary.entities, fresh.m.state.entities.size);
  // the worker never executes proposals and touches no network in the toy
  assert.equal((await store.readAll({ domain: 'toy', kinds: ['proposal.executed', 'source.polled'] })).length, 0);
});

test('spearman sanity', () => {
  assert.equal(spearman([0, 1, 2, 3], [1, 2, 3, 4]), 1);
  assert.equal(spearman([0, 1, 2, 3], [4, 3, 2, 1]), -1);
});

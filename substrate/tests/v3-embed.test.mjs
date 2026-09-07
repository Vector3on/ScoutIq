import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core/store.mjs';
import { Ledger } from '../core/ledger.mjs';
import { Policy } from '../policy/policy.mjs';
import { project } from '../core/projections.mjs';
import { memoryProjection, MemoryVectors } from '../core/memory.mjs';
import { exportTexts, importVectors } from '../core/embedio.mjs';
import { loadPlugin } from '../core/plugins.mjs';
import { runOnce } from '../core/worker.mjs';
import { makeRng } from '../core/events.mjs';
import { posteriorValue, selectJudgments, makeValueModelProjection, expectedImprovement } from '../core/valuemodel.mjs';
import { foldEvents } from '../core/projections.mjs';
import { makeEvent, Clock } from '../core/events.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EPOCH = Date.UTC(2026, 0, 1);
const DAY = 86400000;

test('external embeddings: texts export, vectors import as events, the dominant space takes over, and the loop keeps running', async () => {
  const store = await openStore(':memory:');
  const plugin = await loadPlugin('./plugins/toy/index.mjs', { seed: 9, epoch: EPOCH }, { baseDir: ROOT });
  await runOnce({ store, plugin, domain: 'toy', node: 'n', env: { LOAM_AUTONOMOUS: '1' }, now: EPOCH + 1000, seed: 'a', config: { budgetSeconds: 6 } });
  let mem = (await project(store, memoryProjection, { domain: 'toy', saveSnapshot: false })).state;
  const texts = exportTexts(mem);
  assert.ok(texts.length > 20 && texts.every((t) => t.entityId && t.text));
  assert.equal(new MemoryVectors(mem).space, 'hash');
  // a "real encoder": deterministic 32-d vectors from a seeded rng, for 80% of the texts
  const rng = makeRng(1);
  const lines = texts.slice(0, Math.ceil(texts.length * 0.8)).map((t) => JSON.stringify({ entityId: t.entityId, vec: Array.from({ length: 32 }, () => rng.gauss()) }));
  lines.push('not json', JSON.stringify({ entityId: 'paper:nope', vec: [1, 2] }), JSON.stringify({ entityId: texts[0].entityId, vec: [1, 2, 3] }));
  const ledger = await new Ledger({ store, node: 'embedder', policy: new Policy({}, { env: {} }), domain: 'toy' }).init();
  const r = await importVectors(ledger, lines, { embedder: 'test-32', memory: mem });
  assert.equal(r.dim, 32); assert.equal(r.bad, 3, 'non-JSON and wrong-dimension lines are bad'); assert.equal(r.skipped, 0); assert.equal(r.imported, lines.length - 3);
  const again = await importVectors(ledger, lines.slice(0, 5), { embedder: 'test-32', memory: mem });
  assert.equal(again.imported, 0, 'identical vectors are deduplicated');
  mem = (await project(store, memoryProjection, { domain: 'toy', saveSnapshot: false })).state;
  const vectors = new MemoryVectors(mem);
  assert.equal(vectors.space, 'test-32'); assert.equal(vectors.dim, 32);
  const v = vectors.get(texts[0].entityId);
  assert.equal(v.length, 32);
  assert.ok(Math.abs(v.reduce((s, x) => s + x * x, 0) - 1) < 1e-3, 'normalised');
  assert.equal(vectors.get(texts[texts.length - 1].entityId), null, 'an entity without an external vector has no vector in the external space');
  assert.equal(vectors.embedText('anything'), null);
  assert.equal(exportTexts(mem).length, texts.length - r.imported, 'export lists only what still lacks a vector');
  const res = await runOnce({ store, plugin, domain: 'toy', node: 'n', env: { LOAM_AUTONOMOUS: '1' }, now: EPOCH + DAY + 1000, seed: 'b', config: { budgetSeconds: 6, descriptor: 'both' } });
  assert.ok(res.findings.length > 0, 'the loop runs in the external space (spread, outliers, soft novelty, phenotypes)');
});

test('judgments are evidence: precision-weighted combination and knowledge-gradient EI', () => {
  const proj = makeValueModelProjection({ dim: 64, priorVar: 0.005, noiseVar: 0.03 });
  const c = new Clock('v', () => 1); let seq = 0;
  const ev = (kind, body) => makeEvent({ node: 'v', seq: ++seq, hlc: c.tick(), kind, ts: body.ts ?? 1, domain: 'd', body });
  const list = [];
  for (let i = 0; i < 30; i++) { list.push(ev('value.features', { entityId: `e${i}`, features: { 'type=paper': 1, 'k=A': 1 }, pluginScore: 0.4, ts: i })); list.push(ev('judgment.recorded', { entityId: `e${i}`, value: 0.4, by: 'o', ts: i })); }
  const state = foldEvents(proj, list, { domain: 'd' }).state;
  const f = { 'type=paper': 1, 'k=A': 1 };
  const p = posteriorValue(state, f, 0.4, 0.9, { judgmentSd: 0.15 });
  assert.ok(p.value > 0.4 && p.value < 0.9, `a 0.9 judgment pulls a well-calibrated 0.4 estimate up, not all the way: ${p.value}`);
  const trusting = posteriorValue(state, f, 0.4, 0.9, { judgmentSd: 0.01 });
  assert.ok(trusting.value > p.value, 'a more precise judgment counts for more');
  assert.ok(expectedImprovement(0.5, 0.1, 0.5) > 0 && expectedImprovement(0.9, 0.01, 0.5) > expectedImprovement(0.1, 0.01, 0.5));
  const cands = [{ entityId: 'x', features: f, pluginScore: 0.4, score: 0.4 }, { entityId: 'y', features: { 'type=paper': 1, 'k=Z': 1 }, pluginScore: 0.4, score: 0.4 }];
  const noisy = selectJudgments(state, cands, { k: 2, mode: 'ei', cutoff: 0.45, judgmentSd: 0.15 });
  const precise = selectJudgments(state, cands, { k: 2, mode: 'ei', cutoff: 0.45, judgmentSd: 0.01 });
  assert.ok(precise[0].priority > noisy[0].priority, 'a noisier judgment is worth less (knowledge gradient)');
  assert.equal(noisy[0].entityId, 'y', 'the unseen feature combination is the better thing to ask about');
});

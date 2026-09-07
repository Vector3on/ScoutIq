import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core/store.mjs';
import { loadPlugin } from '../core/plugins.mjs';
import { runOnce } from '../core/worker.mjs';
import { buildBundle, parseJudgments, ingestJudgments } from '../core/bundle.mjs';
import { project } from '../core/projections.mjs';
import { archiveProjection } from '../core/archive.mjs';
import { Ledger } from '../core/ledger.mjs';
import { Policy } from '../policy/policy.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EPOCH = Date.UTC(2026, 0, 1);
const DAY = 86400000;

test('bundle → judgment → next run: the reasoner becomes a sensor', async () => {
  const store = await openStore(':memory:');
  const plugin = await loadPlugin('./plugins/toy/index.mjs', { seed: 7, epoch: EPOCH }, { baseDir: ROOT });
  const common = { store, plugin, domain: 'toy', node: 'test.node', env: { LOAM_AUTONOMOUS: '1' }, config: { budgetSeconds: 6 } };
  const r1 = await runOnce({ ...common, now: EPOCH + 1000, seed: 'a' });
  assert.ok(r1.findings.length > 0);
  const md = await buildBundle(store, { domain: 'toy', top: 5, now: EPOCH + 2000 });
  for (const h of ['## Status', '## Top findings', '## Attention', '## Strategy archive', '## Reply format', '```loam-judgment']) assert.ok(md.includes(h), `missing ${h}`);
  assert.ok(md.includes(r1.findings[0].findingId));
  const target = r1.findings[0];
  const reply = `Here are my ratings.\n\n\`\`\`loam-judgment\nfinding ${target.findingId} 0.05 obvious noise\nentity paper:d0-3 0.95 this one matters\nstrategy {"seed":{"op":"recent","type":"paper","days":3},"pipe":[{"op":"newcomer","rel":"authored_by","dir":"in","recentDays":3,"priorDays":3}],"rank":{"by":"value"}}\nnote the t0/t2 bridge looks real\nbogus line here\nfinding xyz 7 out of range\n\`\`\``;
  const parsed = parseJudgments(reply);
  assert.equal(parsed.judgments.length, 2); assert.equal(parsed.strategies.length, 1); assert.equal(parsed.notes.length, 1);
  assert.equal(parsed.errors.length, 2);
  const arch = await project(store, archiveProjection, { domain: 'toy', saveSnapshot: false });
  const policy = new Policy({}, { env: {} });
  const ledger = await new Ledger({ store, node: 'operator.test', policy, domain: 'toy', now: () => EPOCH + 3000 }).init();
  const n = await ingestJudgments(ledger, parsed, { archive: arch.state, by: 'tester', now: EPOCH + 3000 });
  assert.equal(n, 4);
  const arch2 = await project(store, archiveProjection, { domain: 'toy', saveSnapshot: false });
  assert.equal(arch2.state.judgments.get(target.entityId).value, 0.05);
  assert.equal(arch2.state.seeded.length, 1);
  // next run: the judged-down entity's value is overridden, and the seeded genome gets evaluated
  const r2 = await runOnce({ ...common, now: EPOCH + DAY + 1000, seed: 'b' });
  const evald = await store.readAll({ domain: 'toy', kinds: ['strategy.evaluated'] });
  assert.ok(evald.some((e) => e.body.kind === 'seeded'), 'human-seeded strategy was evaluated');
  assert.ok(!r2.findings.some((f) => f.entityId === target.entityId && f.value > 0.05));
  assert.ok(r2.summary.calibration && r2.summary.calibration.n >= 1);
});

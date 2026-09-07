// plugins/bounty/demo.mjs — one (or a few) end-to-end heartbeats over a FIXTURE feed,
// fully offline. Prints the alpha queue and the top target's full coverage chart.
//
//   node plugins/bounty/demo.mjs [--runs N] [--judge] [--feed <path>]
//
// Offline by construction: a local fetch serves the fixture and an allow-all
// robots.txt. No live target is ever contacted. `--judge` closes the teacher
// loop with a STAND-IN operator (an oracle) so you can watch the value model
// recalibrate; in production a human answers the bundle instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../core/store.mjs';
import { runOnce } from '../../core/worker.mjs';
import { loadPlugin } from '../../core/plugins.mjs';
import { Ledger } from '../../core/ledger.mjs';
import { Policy } from '../../policy/policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const RUNS = Number(args.runs ?? 1);
const FEED = path.resolve(ROOT, String(args.feed ?? 'tests/fixtures/bounty-feed.json'));
const feedText = fs.readFileSync(FEED, 'utf8');

function fetchImpl(url) {
  const u = new URL(url);
  const ok = (body, status = 200) => ({ status, ok: status < 300, headers: new Map(), text: async () => body });
  if (u.pathname === '/robots.txt') return Promise.resolve(ok('User-agent: *\nDisallow:\n'));
  if (u.hostname === 'raw.githubusercontent.com') return Promise.resolve(ok(feedText));
  return Promise.resolve(ok('', 404));
}

// A STAND-IN operator: rates a lead by anatomy interest and EV. This is the
// human's seat in production — here it just proves the loop closes.
function oracleValue(entity) {
  const classes = entity.attrs?.classIds ?? [];
  const interest = classes.some((c) => ['identity', 'agents', 'defi', 'l2', 'cloud'].includes(c)) ? 0.85 : 0.45;
  const evNorm = Math.min(1, Math.log1p(Number(entity.attrs?.signals?.ev ?? 0)) / Math.log1p(50000));
  return Number(Math.max(0, Math.min(1, 0.6 * interest + 0.4 * evNorm)).toFixed(2));
}

const store = await openStore(':memory:');
const config = { budgetSeconds: 30, valueModel: true, judgmentsPerRun: 6, activeJudgments: true, maxFindings: 10 };
const domain = 'bounty';
const outDir = path.join(ROOT, 'out', domain);
let clock = Date.UTC(2026, 8, 5, 12);
let res;
for (let i = 0; i < RUNS; i++) {
  const plugin = await loadPlugin('./plugins/bounty/index.mjs', {}, { baseDir: ROOT });
  res = await runOnce({ store, plugin, domain, node: 'demo.node', env: { LOAM_AUTONOMOUS: '1' }, wall: () => clock, sleep: async (ms) => { clock += ms; }, fetchImpl, config, now: clock, seed: `demo-${i}`, outDir });
  process.stderr.write(`[demo] run ${i + 1}/${RUNS}: ${res.summary.findings} findings, ${res.summary.newObservations} new obs, ${res.summary.evaluations} evals, value model trained=${res.summary.valueModel?.trained ?? 0}, requested ${res.summary.valueModel?.requested ?? 0} judgments\n`);
  if (args.judge) {
    // read what the substrate asked to be judged, answer as the stand-in operator
    const reqs = (await store.readAll({ domain, kinds: ['judgment.requested'] })).filter((e) => e.body.runId === res.summary.runId);
    const items = reqs.at(-1)?.body.items ?? [];
    const { project } = await import('../../core/projections.mjs');
    const { memoryProjection } = await import('../../core/memory.mjs');
    const memory = (await project(store, memoryProjection, { domain, saveSnapshot: false })).state;
    const policy = new Policy({}, { env: process.env });
    const ledger = await new Ledger({ store, node: 'operator.demo', policy, domain, now: () => clock }).init();
    let n = 0;
    for (const it of items) {
      const e = memory.entities.get(it.entityId);
      if (!e) continue;
      await ledger.emit('judgment.recorded', { findingId: it.findingId ?? null, entityId: it.entityId, value: oracleValue(e), note: 'stand-in operator (demo)', by: 'operator', ts: clock + 1000 });
      n++;
    }
    process.stderr.write(`[demo]   operator answered ${n} judgments\n`);
  }
  clock += 86400000; // next day
}

console.log('\n' + '='.repeat(72));
console.log('ALPHA QUEUE + COVERAGE CHART');
console.log('='.repeat(72) + '\n');
const md = fs.readFileSync(path.join(outDir, 'alpha-queue.md'), 'utf8');
console.log(md);
await store.close();

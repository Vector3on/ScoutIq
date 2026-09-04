// core/experiment.mjs — the falsification protocol (DESIGN.md §6).
//
// Runs the substrate on the toy world under controlled variants and reports:
//   compounding : with persistent state, true value per run rises over runs
//                 and beats the memoryless ablation (state wiped each run);
//   open-ended  : archive coverage grows, outputs keep coming, strategy
//                 entropy stays high, and the single-cell (no QD) ablation
//                 covers less of behavior space.
import { openStore } from './store.mjs';
import { runOnce } from './worker.mjs';
import { loadPlugin } from './plugins.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cellOf } from './strategy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86400000;

export function spearman(xs, ys) {
  const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => { r[i] = k; }); return r; };
  const rx = rank(xs), ry = rank(ys), n = xs.length;
  if (n < 3) return 0;
  const mx = (n - 1) / 2, my = (n - 1) / 2;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (rx[i] - mx) * (ry[i] - my); sxx += (rx[i] - mx) ** 2; syy += (ry[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

export async function runVariant({ variant, runs, budgetSeconds, seed, epoch, log = () => {}, pluginOptions = {} }) {
  const plugin = await loadPlugin('./plugins/toy/index.mjs', { seed, epoch, ...pluginOptions }, { baseDir: here + '/..' });
  const config = { budgetSeconds, bins: variant === 'single-cell' ? 1 : 6, randomGenomes: variant === 'single-cell' ? 3 : 3 };
  let store = variant === 'memoryless' ? null : await openStore(':memory:');
  const series = [];
  const reported = new Set(); // harness-level dedup: a discovery counts once per experiment, whatever the variant remembers
  const illuminated = new Set(); // behaviour cells (fixed 6-bin grid) reached with positive fitness, across the whole experiment
  const productive = new Set(); // distinct strategies that produced delivered findings
  for (let i = 0; i < runs; i++) {
    if (variant === 'memoryless') store = await openStore(':memory:');
    const now = epoch + i * DAY + 12 * 3600 * 1000;
    const res = await runOnce({ store, plugin, domain: 'toy', node: `exp.${variant}`, role: 'experiment', env: { LOAM_AUTONOMOUS: '1' }, now, seed: `${seed}:${variant}:${i}`, config, log, policyConfig: {} });
    const papers = res.findings.filter((f) => !reported.has(f.entityId) && !f.entityId.startsWith('topic:'));
    for (const f of res.findings) reported.add(f.entityId);
    const trueValues = papers.map((f) => plugin.debug.trueValue(f.entityId, now));
    const top5 = papers.slice().sort((a, b) => b.score - a.score).slice(0, 5).map((f) => plugin.debug.trueValue(f.entityId, now));
    for (const ev of await store.readAll({ domain: 'toy', kinds: ['strategy.evaluated'] })) if (ev.body.fitness > 0 && ev.body.bd) illuminated.add(cellOf(ev.body.bd, 6));
    for (const f of res.findings) productive.add(f.strategyId);
    const s = res.summary;
    series.push({
      run: i, findings: s.findings, papers: papers.length, trueValue: Number(trueValues.reduce((a, b) => a + b, 0).toFixed(4)), meanTrue: Number(mean(trueValues).toFixed(4)), top5True: Number(mean(top5).toFixed(4)),
      hits: trueValues.filter((v) => v >= 0.35).length, novelValue: s.novelValue, meanNovelty: s.meanNovelty, coverage: s.coverage, cells: s.archiveCells,
      qdScore: s.qdScore, entropy: s.strategyEntropy, distinct: s.distinctStrategies, evaluations: s.evaluations, newObs: s.newObservations, entities: s.entities, elapsedMs: s.elapsedMs,
      illuminated: illuminated.size, productiveStrategies: productive.size, byType: s.byType,
    });
  }
  return { variant, series };
}

export async function runExperiment({ runs = 8, budgetSeconds = 10, seed = 7, variants = ['memory', 'memoryless', 'single-cell'], log = () => {}, epoch = Date.UTC(2026, 0, 1) } = {}) {
  const results = {};
  for (const v of variants) results[v] = (await runVariant({ variant: v, runs, budgetSeconds, seed, epoch, log })).series;
  return { results, verdicts: verdicts(results, runs) };
}

export function verdicts(results, runs) {
  const mem = results.memory ?? [], nomem = results.memoryless ?? [], single = results['single-cell'] ?? [];
  const third = Math.max(2, Math.floor(runs / 3));
  const last = (s, f) => s.slice(-third).map(f), first = (s, f) => s.slice(0, third).map(f);
  const v = {};
  if (mem.length) {
    const tv = mem.map((r) => r.trueValue);
    v.trend = Number(spearman(mem.map((r) => r.run), tv).toFixed(3));
    v.lateVsEarly = Number((mean(last(mem, (r) => r.trueValue)) / Math.max(1e-6, mean(first(mem, (r) => r.trueValue)))).toFixed(3));
  }
  if (mem.length && nomem.length) {
    v.memoryVsMemoryless = Number((mean(last(mem, (r) => r.trueValue)) / Math.max(1e-6, mean(last(nomem, (r) => r.trueValue)))).toFixed(3));
    v.hitsMemory = mem.reduce((s, r) => s + r.hits, 0); v.hitsMemoryless = nomem.reduce((s, r) => s + r.hits, 0);
    // paired advantage over the same world days controls for the world's own non-stationarity
    v.advantageTrend = Number(spearman(mem.map((r) => r.run), mem.map((r, i) => r.trueValue - nomem[i].trueValue)).toFixed(3));
    v.compounding = v.memoryVsMemoryless > 1.1;
  }
  if (mem.length) {
    v.coverageGrowth = Number((mem[mem.length - 1].coverage - mem[0].coverage).toFixed(4));
    v.minFindings = Math.min(...mem.map((r) => r.findings));
    v.lateEntropy = Number(mean(last(mem, (r) => r.entropy)).toFixed(3));
    v.lateNovelty = Number(mean(last(mem, (r) => r.meanNovelty)).toFixed(3));
    v.openEnded = v.coverageGrowth > 0 && v.minFindings > 0 && v.lateEntropy >= 1 && v.lateNovelty >= 0.3;
  }
  if (mem.length && single.length) {
    v.illuminatedMemory = mem[mem.length - 1].illuminated; v.illuminatedSingle = single[single.length - 1].illuminated;
    v.productiveMemory = mem[mem.length - 1].productiveStrategies; v.productiveSingle = single[single.length - 1].productiveStrategies;
    v.qdVsSingleValue = Number((mean(last(mem, (r) => r.trueValue)) / Math.max(1e-6, mean(last(single, (r) => r.trueValue)))).toFixed(3));
    v.qdMatters = v.illuminatedMemory > v.illuminatedSingle && v.qdVsSingleValue >= 0.9;
  }
  return v;
}

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
import { Ledger } from './ledger.mjs';
import { Policy } from '../policy/policy.mjs';
import { makeRng } from './events.mjs';
import { LinearModel, featurize } from './attention.mjs';
import { entityFeatures } from './features.mjs';
import { DegreeRanks } from './strategy.mjs';
import { SignalRanks } from './phenotype.mjs';
import { MemoryVectors } from './memory.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86400000;

/**
 * v3 variants (DESIGN.md §9). `memory` is the v2 baseline (every addon off);
 * `v3` turns every addon on; `v3-no-X` ablates one; `v3-X` isolates one.
 */
export const V3_ALL = Object.freeze({ descriptor: 'both', frontier: true, valueModel: true, credit: true, sentinel: true });
/** The shipping v3 configuration: what moved a metric and did not cost hidden-truth value (DESIGN.md §9). */
export const V3_DEFAULT = Object.freeze({ descriptor: 'both', valueModel: true, judgmentsPerRun: 10, sentinel: 'observe', frontier: false, credit: false });
export const VARIANT_CONFIGS = Object.freeze({
  memory: {}, memoryless: {}, 'single-cell': { bins: 1 },
  v3: V3_DEFAULT, 'v3-all': V3_ALL,
  'v3-descriptor': { descriptor: 'both' }, 'v3-learned': { descriptor: 'learned' }, 'v3-frontier': { frontier: true },
  'v3-value': { valueModel: true }, 'v3-value-topk': { valueModel: true, activeJudgments: false }, 'v3-credit': { credit: true }, 'v3-sentinel': { sentinel: true },
  'v3-no-descriptor': { ...V3_ALL, descriptor: 'fixed' }, 'v3-no-frontier': { ...V3_ALL, frontier: false }, 'v3-no-value': { ...V3_ALL, valueModel: false },
  'v3-no-credit': { ...V3_ALL, credit: false }, 'v3-no-sentinel': { ...V3_ALL, sentinel: false }, 'v3-topk-judgments': { ...V3_ALL, activeJudgments: false },
});

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

export async function runVariant({ variant, runs, budgetSeconds, seed, epoch, log = () => {}, pluginOptions = {}, config: extraConfig = {}, judgmentsPerRun = 0, judgmentNoise = 0.15 }) {
  const plugin = await loadPlugin('./plugins/toy/index.mjs', { seed, epoch, ...pluginOptions }, { baseDir: here + '/..' });
  const variantConfig = VARIANT_CONFIGS[variant] ?? {};
  const config = { budgetSeconds, bins: variant === 'single-cell' ? 1 : 6, randomGenomes: 3, ...variantConfig, ...(judgmentsPerRun > 0 ? { judgmentsPerRun } : {}), ...extraConfig };
  let store = variant === 'memoryless' ? null : await openStore(':memory:');
  const series = [];
  const reported = new Set(); // harness-level dedup: a discovery counts once per experiment, whatever the variant remembers
  const illuminated = new Set(); // behaviour cells (fixed 6-bin grid) reached with positive fitness, across the whole experiment
  const productive = new Set(); // distinct strategies that produced delivered findings
  const orng = makeRng(`oracle:${seed}:${variant}`);
  let cumTrue = 0, judged = 0, credited = 0, interventions = 0;
  const linear = extraConfig.linearCeiling ? new LinearModel({ dim: 512, priorVar: 0.005, noiseVar: 0.03 }) : null; // hindsight: every past pool item labelled with truth
  for (let i = 0; i < runs; i++) {
    if (variant === 'memoryless') store = await openStore(':memory:');
    const now = epoch + i * DAY + 12 * 3600 * 1000;
    const stream = extraConfig.rngTag ?? variant; // the random stream; pass rngTag to compare configurations under identical streams
    const res = await runOnce({ store, plugin, domain: 'toy', node: `exp.${variant}`, role: 'experiment', env: { LOAM_AUTONOMOUS: '1' }, now, seed: `${seed}:${stream}:${i}`, config, log, policyConfig: {} });
    const papers = res.findings.filter((f) => !reported.has(f.entityId) && !f.entityId.startsWith('topic:'));
    for (const f of res.findings) reported.add(f.entityId);
    const trueValues = papers.map((f) => plugin.debug.trueValue(f.entityId, now));
    const top5 = papers.slice().sort((a, b) => b.score - a.score).slice(0, 5).map((f) => plugin.debug.trueValue(f.entityId, now));
    for (const ev of await store.readAll({ domain: 'toy', kinds: ['strategy.evaluated'] })) if (ev.body.fitness > 0 && ev.body.bd) illuminated.add(cellOf(ev.body.bd, 6));
    for (const f of res.findings) productive.add(f.strategyId);
    // calibration on what was delivered: |estimated value − hidden truth|
    const calibMae = res.findings.length ? mean(res.findings.map((f) => Math.abs(f.value - plugin.debug.trueValue(f.entityId, now)))) : null;
    // where is the ceiling? top-20 hidden truth among: everything that exists (world), what memory holds, what strategies surfaced (pool)
    const ceilings = ceilingsOf({ plugin, store, res, now, reported, k: 20, linear, schema: plugin.schema });
    // the oracle operator: judges what the substrate asked for (v3 active selection) or its top deliveries (v2)
    if (judgmentsPerRun > 0) judged += await oracleJudge({ store, res, plugin, now, judgmentsPerRun, judgmentNoise, rng: orng });
    const s = res.summary;
    cumTrue += trueValues.reduce((a, b) => a + b, 0);
    credited += s.credit?.credited ?? 0;
    if (s.sentinel?.intervention) interventions++;
    series.push({
      run: i, findings: s.findings, papers: papers.length, trueValue: Number(trueValues.reduce((a, b) => a + b, 0).toFixed(4)), cumTrue: Number(cumTrue.toFixed(3)), meanTrue: Number(mean(trueValues).toFixed(4)), top5True: Number(mean(top5).toFixed(4)),
      hits: trueValues.filter((v) => v >= 0.35).length, novelValue: s.novelValue, meanNovelty: s.meanNovelty, coverage: s.coverage, cells: s.archiveCells,
      qdScore: s.qdScore, entropy: s.strategyEntropy, distinct: s.distinctStrategies, evaluations: s.evaluations, newObs: s.newObservations, entities: s.entities, elapsedMs: s.elapsedMs,
      illuminated: illuminated.size, productiveStrategies: productive.size, byType: s.byType, calibMae: calibMae === null ? null : Number(calibMae.toFixed(4)), judged,
      vqCells: s.vq?.cells ?? null, vqK: s.vq?.centroids ?? null, challenges: s.frontier ? { active: s.frontier.active, solved: s.frontier.solved, retired: s.frontier.retired, transfers: s.frontier.transfers, transferElites: s.frontier.transferElites } : null,
      credited, interventions, vmTrained: s.valueModel?.trained ?? null, vmMae: s.valueModel?.mae ?? null, sentinel: s.sentinel ? { stagnant: s.sentinel.stagnant, intervention: s.sentinel.intervention } : null,
      ...(await ceilings),
    });
  }
  return { variant, series };
}

/**
 * Ceiling diagnostics (all exclude entities already counted): the best 20 by hidden truth
 * among the world's documents so far, among memory, and among the strategies' candidate pool.
 *   world − memory  → polls are the bottleneck;  memory − pool → strategies;  pool − delivered → the value model.
 */
async function ceilingsOf({ plugin, store, res, now, reported, k, linear = null, schema = null }) {
  const world = plugin.debug.world;
  const day = Math.floor((now - plugin.debug.epoch) / DAY);
  const topk = (vals) => vals.sort((a, b) => b - a).slice(0, k).reduce((s, x) => s + x, 0);
  const worldVals = [];
  for (let d = Math.max(-world.history, day - 40); d <= day; d++) for (const doc of world.docsForDay(d)) if (!reported.has(`paper:${doc.id}`)) worldVals.push(world.trueValue(doc));
  const { project } = await import('./projections.mjs');
  const { memoryProjection } = await import('./memory.mjs');
  const mem = (await project(store, memoryProjection, { domain: 'toy' })).state;
  const memVals = [];
  for (const id of mem.byType.get('paper') ?? []) if (!reported.has(id)) memVals.push(plugin.debug.trueValue(id, now));
  const poolItems = (res.pool ?? []).filter((f) => !reported.has(f.entityId) || res.findings.some((x) => x.entityId === f.entityId));
  const poolVals = poolItems.map((f) => plugin.debug.trueValue(f.entityId, now));
  let ceilLinear = null;
  if (linear && schema) {
    // score the current pool with a ridge model trained on ALL previous pool items' hidden truth, then train on this pool
    const degreeRanks = new DegreeRanks(mem), signalRanks = new SignalRanks(mem, schema.signals);
    const rows = poolItems.map((f) => { const raw = f.value ?? 0; const phi = featurize(entityFeatures(f.entityId, { memory: mem, schema, now, degreeRanks, signalRanks, pluginScore: raw, tokens: false }), linear.dim); return { phi, raw, truth: plugin.debug.trueValue(f.entityId, now) }; });
    if (linear.n >= 20) {
      const preds = rows.map((r) => ({ p: Math.max(0, Math.min(1, r.raw + linear.mean(r.phi))), t: r.truth })).sort((a, b) => b.p - a.p).slice(0, k);
      ceilLinear = Number(preds.reduce((s, x) => s + x.t, 0).toFixed(3));
    }
    for (const r of rows) linear.update(r.phi, r.truth - r.raw);
  }
  return { ceilWorld: Number(topk(worldVals).toFixed(3)), ceilMemory: Number(topk(memVals).toFixed(3)), ceilPool: Number(topk(poolVals).toFixed(3)), poolN: (res.pool ?? []).length, ceilLinear };
}

/** Simulated operator: noisy hidden truth on the items the substrate asked about. */
async function oracleJudge({ store, res, plugin, now, judgmentsPerRun, judgmentNoise, rng }) {
  const reqs = (await store.readAll({ domain: 'toy', kinds: ['judgment.requested'] })).filter((e) => e.body.runId === res.summary.runId);
  let items = reqs.length ? reqs[reqs.length - 1].body.items : res.findings.slice().sort((a, b) => b.score - a.score).map((f) => ({ entityId: f.entityId, findingId: f.findingId }));
  items = items.slice(0, judgmentsPerRun);
  if (!items.length) return 0;
  const ledger = await new Ledger({ store, node: 'oracle', policy: new Policy({}, { env: {} }), domain: 'toy', now: () => now + 1000 }).init();
  for (const it of items) {
    const value = Math.max(0, Math.min(1, plugin.debug.trueValue(it.entityId, now) + rng.gauss() * judgmentNoise));
    await ledger.emit('judgment.recorded', { findingId: it.findingId ?? null, entityId: it.entityId, value: Number(value.toFixed(3)), note: 'oracle', by: 'oracle', ts: now + 1000 });
  }
  return items.length;
}

export async function runExperiment({ runs = 8, budgetSeconds = 10, seed = 7, variants = ['memory', 'memoryless', 'single-cell'], log = () => {}, epoch = Date.UTC(2026, 0, 1), judgmentsPerRun = 0, config = {} } = {}) {
  const results = {};
  for (const v of variants) results[v] = (await runVariant({ variant: v, runs, budgetSeconds, seed, epoch, log, judgmentsPerRun, config })).series;
  return { results, verdicts: verdicts(results, runs) };
}

/** v3 verdicts: ceiling moved? (v3 vs the v2 baseline) and per-addon ablations. */
export function v3Verdicts(results, runs) {
  const third = Math.max(2, Math.floor(runs / 3));
  const late = (s, f) => mean(s.slice(-third).map(f));
  const cum = (s) => s[s.length - 1]?.cumTrue ?? 0;
  const ratio = (a, b) => Number((a / Math.max(1e-6, b)).toFixed(3));
  const out = {};
  const base = results.memory, v3 = results.v3;
  if (base && v3) {
    out.ceiling = {
      lateTrueValue: { v3: r3(late(v3, (r) => r.trueValue)), v2: r3(late(base, (r) => r.trueValue)), ratio: ratio(late(v3, (r) => r.trueValue), late(base, (r) => r.trueValue)) },
      cumulativeTrueValue: { v3: r3(cum(v3)), v2: r3(cum(base)), ratio: ratio(cum(v3), cum(base)) },
      lateHits: { v3: r3(late(v3, (r) => r.hits)), v2: r3(late(base, (r) => r.hits)) },
      sustainedNovelValue: { v3: r3(late(v3, (r) => r.novelValue)), v2: r3(late(base, (r) => r.novelValue)), ratio: ratio(late(v3, (r) => r.novelValue), late(base, (r) => r.novelValue)) },
      illuminatedFixedGrid: { v3: v3.at(-1).illuminated, v2: base.at(-1).illuminated },
      learnedCells: v3.at(-1).vqCells,
      productiveStrategies: { v3: v3.at(-1).productiveStrategies, v2: base.at(-1).productiveStrategies },
      calibMae: { v3: r3(late(v3, (r) => r.calibMae ?? 0)), v2: r3(late(base, (r) => r.calibMae ?? 0)) },
      interventions: v3.at(-1).interventions, judged: v3.at(-1).judged,
      moved: late(v3, (r) => r.trueValue) > 1.1 * late(base, (r) => r.trueValue) && cum(v3) > cum(base),
    };
  }
  out.ablations = {};
  for (const [name, key] of [['descriptor', 'v3-no-descriptor'], ['frontier', 'v3-no-frontier'], ['value', 'v3-no-value'], ['credit', 'v3-no-credit'], ['sentinel', 'v3-no-sentinel'], ['activeJudgments', 'v3-topk-judgments']]) {
    if (!v3 || !results[key]) continue;
    const w = results[key];
    out.ablations[name] = { lateWith: r3(late(v3, (r) => r.trueValue)), lateWithout: r3(late(w, (r) => r.trueValue)), ratio: ratio(late(v3, (r) => r.trueValue), late(w, (r) => r.trueValue)), cumRatio: ratio(cum(v3), cum(w)), helps: cum(v3) > cum(w) };
  }
  for (const [name, key] of [['descriptor', 'v3-descriptor'], ['learned', 'v3-learned'], ['frontier', 'v3-frontier'], ['value', 'v3-value'], ['valueTopK', 'v3-value-topk'], ['credit', 'v3-credit'], ['sentinel', 'v3-sentinel']]) {
    if (!base || !results[key]) continue;
    const w = results[key];
    out.isolated = out.isolated ?? {};
    out.isolated[name] = { late: r3(late(w, (r) => r.trueValue)), lateV2: r3(late(base, (r) => r.trueValue)), ratio: ratio(late(w, (r) => r.trueValue), late(base, (r) => r.trueValue)), cumRatio: ratio(cum(w), cum(base)), illuminated: w.at(-1).illuminated, vqCells: w.at(-1).vqCells, productive: w.at(-1).productiveStrategies, calibMae: r3(late(w, (r) => r.calibMae ?? 0)), sustainedNovelRatio: ratio(late(w, (r) => r.novelValue), late(base, (r) => r.novelValue)) };
  }
  return out;
}
const r3 = (x) => Number(Number(x).toFixed(3));

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

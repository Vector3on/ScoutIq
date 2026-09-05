// core/experiment.mjs — the falsification protocol (DESIGN.md §6).
//
// Runs the substrate on the toy world under controlled variants and reports:
//   compounding : with persistent state, true value per run rises over runs
//                 and beats the memoryless ablation (state wiped each run);
//   open-ended  : archive coverage grows, outputs keep coming, strategy
//                 entropy stays high, and the single-cell (no QD) ablation
//                 covers less of behavior space.
import { openStore } from './store.mjs';
import { project } from './projections.mjs';
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
import { makeValueModelV4Projection } from './valuemodel-v4.mjs';
import { makeObsContext, evalAll, bucketOf, describeProgram } from './observables.mjs';
import { spearman as rankCorr } from './hindsight.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86400000;

/**
 * v3 variants (DESIGN.md §9). `memory` is the v2 baseline (every addon off);
 * `v3` turns every addon on; `v3-no-X` ablates one; `v3-X` isolates one.
 */
export const V3_ALL = Object.freeze({ descriptor: 'both', frontier: true, valueModel: true, credit: true, sentinel: true });
/** The shipping v3 configuration: what moved a metric and did not cost hidden-truth value (DESIGN.md §9). */
export const V3_DEFAULT = Object.freeze({ descriptor: 'both', valueModel: true, judgmentsPerRun: 10, sentinel: 'observe', frontier: false, credit: false });
/**
 * v4 (DESIGN.md §10): hindsight labels, learned observables (and their entry into the strategy grammar),
 * retrospective curriculum, learning-progress meta-attention. `v4` is the shipping configuration; `v4-all`
 * turns every v4 addon on; `v4-X` isolates one on top of v3; `v4-no-X` ablates one from `v4-all`.
 */
export const V4_ALL = Object.freeze({ ...V3_DEFAULT, hindsight: true, discovery: true, obsOps: true, curriculum: true, progress: 'observe', metaAttention: true });
export const V4_DEFAULT = Object.freeze({ ...V3_DEFAULT, hindsight: true, discovery: true, obsOps: true, curriculum: true, progress: 'observe', metaAttention: true });
export const VARIANT_CONFIGS = Object.freeze({
  memory: {}, memoryless: {}, 'single-cell': { bins: 1 },
  v3: V3_DEFAULT, 'v3-all': V3_ALL,
  v4: V4_DEFAULT, 'v4-all': V4_ALL,
  'v4-hindsight': { ...V3_DEFAULT, hindsight: true }, 'v4-discovery': { ...V3_DEFAULT, hindsight: true, discovery: true }, 'v4-discovery-judgments': { ...V3_DEFAULT, discovery: true },
  'v4-obsops': { ...V3_DEFAULT, hindsight: true, discovery: true, obsOps: true }, 'v4-obsops-judgments': { ...V3_DEFAULT, discovery: true, obsOps: true }, 'v4-curriculum': { ...V3_DEFAULT, hindsight: true, curriculum: true },
  'v4-no-discovery': { ...V4_ALL, discovery: false, obsOps: false }, 'v4-no-obsops': { ...V4_ALL, obsOps: false }, 'v4-no-curriculum': { ...V4_ALL, curriculum: false },
  'v4-fixed': { ...V4_ALL, metaAttention: false }, 'v4-progress': { ...V4_ALL, progress: true }, 'v4-nostack': { ...V4_ALL, vmStack: false },
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
  const linearObs = extraConfig.linearCeiling ? new LinearModel({ dim: 512, priorVar: 0.005, noiseVar: 0.03 }) : null; // the same, over base features ⊕ adopted observables
  const isV4 = !!(config.hindsight || config.discovery);
  const vmProj = isV4 ? makeValueModelV4Projection({ dim: config.vmDim ?? 256 }) : null;
  for (let i = 0; i < runs; i++) {
    if (variant === 'memoryless') store = await openStore(':memory:');
    const now = epoch + i * DAY + 12 * 3600 * 1000;
    const stream = extraConfig.rngTag ?? variant; // the random stream; pass rngTag to compare configurations under identical streams
    // A logical wall clock (one millisecond per read) makes learned action costs, event times and time-travel cutoffs a
    // function of the log alone, so an experiment is exactly reproducible whatever the machine is doing (v4; D23).
    const t0 = Date.now();
    const wall = extraConfig.realClock ? undefined : (() => { let t = now - 1; return () => ++t; })();
    const res = await runOnce({ store, plugin, domain: 'toy', node: `exp.${variant}`, role: 'experiment', env: { LOAM_AUTONOMOUS: '1' }, now, wall, seed: `${seed}:${stream}:${i}`, config, log, policyConfig: {} });
    const wallMs = Date.now() - t0;
    const papers = res.findings.filter((f) => !reported.has(f.entityId) && !f.entityId.startsWith('topic:'));
    for (const f of res.findings) reported.add(f.entityId);
    const trueValues = papers.map((f) => plugin.debug.trueValue(f.entityId, now));
    const top5 = papers.slice().sort((a, b) => b.score - a.score).slice(0, 5).map((f) => plugin.debug.trueValue(f.entityId, now));
    for (const ev of await store.readAll({ domain: 'toy', kinds: ['strategy.evaluated'] })) if (ev.body.fitness > 0 && ev.body.bd) illuminated.add(cellOf(ev.body.bd, 6));
    for (const f of res.findings) productive.add(f.strategyId);
    // calibration on what was delivered: |estimated value − hidden truth|
    const calibMae = res.findings.length ? mean(res.findings.map((f) => Math.abs(f.value - plugin.debug.trueValue(f.entityId, now)))) : null;
    // where is the ceiling? top-20 hidden truth among: everything that exists (world), what memory holds, what strategies surfaced (pool)
    const ceilings = ceilingsOf({ plugin, store, res, now, reported, k: 20, linear, linearObs, schema: plugin.schema, vmProj });
    const v4 = isV4 ? await v4Metrics({ plugin, store, res, now, vmProj }) : null;
    // the oracle operator: judges what the substrate asked for (v3 active selection) or its top deliveries (v2)
    if (judgmentsPerRun > 0) judged += await oracleJudge({ store, res, plugin, now, judgmentsPerRun, judgmentNoise, rng: orng });
    const s = res.summary;
    cumTrue += trueValues.reduce((a, b) => a + b, 0);
    credited += s.credit?.credited ?? 0;
    if (s.sentinel?.intervention) interventions++;
    series.push({
      run: i, findings: s.findings, papers: papers.length, trueValue: Number(trueValues.reduce((a, b) => a + b, 0).toFixed(4)), cumTrue: Number(cumTrue.toFixed(3)), meanTrue: Number(mean(trueValues).toFixed(4)), top5True: Number(mean(top5).toFixed(4)),
      hits: trueValues.filter((v) => v >= 0.35).length, novelValue: s.novelValue, meanNovelty: s.meanNovelty, coverage: s.coverage, cells: s.archiveCells,
      qdScore: s.qdScore, entropy: s.strategyEntropy, distinct: s.distinctStrategies, evaluations: s.evaluations, newObs: s.newObservations, entities: s.entities, elapsedMs: wallMs,
      illuminated: illuminated.size, productiveStrategies: productive.size, byType: s.byType, calibMae: calibMae === null ? null : Number(calibMae.toFixed(4)), judged,
      vqCells: s.vq?.cells ?? null, vqK: s.vq?.centroids ?? null, challenges: s.frontier ? { active: s.frontier.active, solved: s.frontier.solved, retired: s.frontier.retired, transfers: s.frontier.transfers, transferElites: s.frontier.transferElites } : null,
      credited, interventions, vmTrained: s.valueModel?.trained ?? null, vmMae: s.valueModel?.mae ?? null, sentinel: s.sentinel ? { stagnant: s.sentinel.stagnant, intervention: s.sentinel.intervention } : null,
      ...(await ceilings),
      ...(v4 ? { v4 } : {}),
    });
  }
  return { variant, series, ...(extraConfig.keepStore ? { store } : {}) };
}

/**
 * Ceiling diagnostics (all exclude entities already counted): the best 20 by hidden truth
 * among the world's documents so far, among memory, and among the strategies' candidate pool.
 *   world − memory  → polls are the bottleneck;  memory − pool → strategies;  pool − delivered → the value model.
 */
async function ceilingsOf({ plugin, store, res, now, reported, k, linear = null, linearObs = null, schema = null, vmProj = null }) {
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
  let ceilLinear = null, ceilLinearObs = null;
  if (linear && schema) {
    // score the current pool with a ridge model trained on ALL previous pool items' hidden truth, then train on this pool
    const degreeRanks = new DegreeRanks(mem), signalRanks = new SignalRanks(mem, schema.signals);
    // v4: the same ceiling over base features ⊕ the observables the substrate has adopted so far (bucketed on their adoption edges)
    const vm = vmProj ? (await project(store, vmProj, { domain: 'toy', saveSnapshot: false })).state : null;
    const adopted = vm ? [...vm.observables.adopted.values()] : [];
    const octx = adopted.length ? makeObsContext({ memory: mem, now, schema, degreeRanks, signalRanks }) : null;
    const rows = poolItems.map((f) => {
      const raw = f.value ?? 0;
      const base = entityFeatures(f.entityId, { memory: mem, schema, now, degreeRanks, signalRanks, pluginScore: raw, tokens: false });
      const withObs = { ...base };
      if (octx) { const o = evalAll(octx, adopted, f.entityId); for (const a of adopted) withObs[`obs:${a.id}`] = bucketOf(o[a.id], a.edges); }
      return { phi: featurize(base, linear.dim), phiObs: featurize(withObs, linearObs.dim), raw, truth: plugin.debug.trueValue(f.entityId, now) };
    });
    if (linear.n >= 20) {
      const preds = rows.map((r) => ({ p: Math.max(0, Math.min(1, r.raw + linear.mean(r.phi))), t: r.truth })).sort((a, b) => b.p - a.p).slice(0, k);
      ceilLinear = Number(preds.reduce((s, x) => s + x.t, 0).toFixed(3));
      const predsObs = rows.map((r) => ({ p: Math.max(0, Math.min(1, r.raw + linearObs.mean(r.phiObs))), t: r.truth })).sort((a, b) => b.p - a.p).slice(0, k);
      ceilLinearObs = Number(predsObs.reduce((s, x) => s + x.t, 0).toFixed(3));
    }
    for (const r of rows) { linear.update(r.phi, r.truth - r.raw); linearObs.update(r.phiObs, r.truth - r.raw); }
  }
  return { ceilWorld: Number(topk(worldVals).toFixed(3)), ceilMemory: Number(topk(memVals).toFixed(3)), ceilPool: Number(topk(poolVals).toFixed(3)), poolN: (res.pool ?? []).length, ceilLinear, ceilLinearObs };
}

/**
 * v4 falsification metrics per run (toy-only, hidden truth):
 *   hindCorr    — rank correlation between this run's hindsight labels and hidden truth (the label is useless if ≈ 0);
 *   hindTop     — mean hidden truth of the 20 highest hindsight labels of the batch, against the batch's best 20 (label precision);
 *   observables — what was adopted, and their fitness;
 *   alloc       — how the attention model spent the heartbeat across mechanisms.
 */
async function v4Metrics({ plugin, store, res, now, vmProj }) {
  const s = res.summary;
  const vm = (await project(store, vmProj, { domain: 'toy', saveSnapshot: false })).state;
  const days = new Set((await store.readAll({ domain: 'toy', kinds: ['hindsight.labeled'] })).filter((e) => e.body.runId === s.runId && !e.body.empty).map((e) => e.body.asOfDay));
  let hindCorr = null, hindTop = null, hindN = 0;
  if (days.size) {
    const rows = vm.rows.filter((r) => r.kind === 'hindsight' && days.has(r.batch));
    const labels = rows.map((r) => r.y), truths = rows.map((r) => plugin.debug.trueValue(r.id, r.batch * DAY + 12 * 3600 * 1000));
    hindN = rows.length;
    if (rows.length >= 10) {
      hindCorr = Number(rankCorr(labels, truths).toFixed(3));
      const byLabel = rows.map((r, i) => [labels[i], truths[i]]).sort((a, b) => b[0] - a[0]).slice(0, 20).reduce((a, x) => a + x[1], 0);
      const best = truths.slice().sort((a, b) => b - a).slice(0, 20).reduce((a, x) => a + x, 0);
      hindTop = best > 0 ? Number((byLabel / best).toFixed(3)) : null;
    }
  }
  const adopted = [...vm.observables.adopted.values()];
  return {
    hindCorr, hindTop, hindN, hindRows: vm.hindRows, labelPairs: vm.labelPairs, labelMae: s.v4?.hindsight?.labelMae ?? null, hindMae: s.v4?.hindsight?.mae ?? null, ig: s.v4?.hindsight?.ig ?? 0,
    adopted: adopted.length, candidates: vm.observables.candidates.size, retired: vm.observables.retired, shapes: vm.observables.shapes.size, adoptedThisRun: s.v4?.observables?.adoptedThisRun ?? 0,
    adoptedNames: adopted.map((o) => ({ id: o.id, name: describeProgram(o.program), fitness: o.fitness })),
    inGrammar: s.v4?.observables?.inGrammar ?? 0, elitesUsingObs: s.v4?.observables?.elitesUsingObs ?? 0,
    curriculum: s.v4?.curriculum ?? null, progress: s.v4?.progress ? { stalled: s.v4.progress.stalled, lpValue: s.v4.progress.lpValue ?? null, intervened: s.v4.progress.intervened ?? null } : null,
    alloc: { hindsight: s.byType?.hindsight ?? 0, discover: s.byType?.discover ?? 0, retro: s.byType?.retro ?? 0, evolve: (s.byType?.evolve ?? 0) + (s.byType?.crossover ?? 0) + (s.byType?.random ?? 0) + (s.byType?.reevaluate ?? 0), poll: s.byType?.poll ?? 0 },
  };
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

/** v4 verdicts: did the ceiling move against v3, and what did each mechanism do (isolated on v3, ablated from v4-all)? */
export function v4Verdicts(results, runs) {
  const third = Math.max(2, Math.floor(runs / 3));
  const late = (s, f) => mean(s.slice(-third).map(f).filter((x) => x !== null && x !== undefined));
  const cum = (s) => s[s.length - 1]?.cumTrue ?? 0;
  const ratio = (a, b) => Number((a / Math.max(1e-6, b)).toFixed(3));
  const out = {};
  const base = results.v3, v4 = results.v4;
  const summarize = (w, ref) => ({
    late: r3(late(w, (r) => r.trueValue)), lateRef: r3(late(ref, (r) => r.trueValue)), ratio: ratio(late(w, (r) => r.trueValue), late(ref, (r) => r.trueValue)),
    cum: r3(cum(w)), cumRef: r3(cum(ref)), cumRatio: ratio(cum(w), cum(ref)),
    hits: w.reduce((s, r) => s + r.hits, 0), hitsRef: ref.reduce((s, r) => s + r.hits, 0),
    sustainedNovelRatio: ratio(late(w, (r) => r.novelValue), late(ref, (r) => r.novelValue)),
    illuminated: w.at(-1).illuminated, illuminatedRef: ref.at(-1).illuminated, vqCells: w.at(-1).vqCells, vqCellsRef: ref.at(-1).vqCells,
    ceilPool: r3(late(w, (r) => r.ceilPool)), ceilPoolRef: r3(late(ref, (r) => r.ceilPool)),
    ceilLinear: r3(late(w, (r) => r.ceilLinear)), ceilLinearObs: r3(late(w, (r) => r.ceilLinearObs)), ceilLinearRef: r3(late(ref, (r) => r.ceilLinear)),
    hindCorr: r3(late(w, (r) => r.v4?.hindCorr ?? null)), hindTop: r3(late(w, (r) => r.v4?.hindTop ?? null)), adopted: w.at(-1).v4?.adopted ?? 0, elitesUsingObs: w.at(-1).v4?.elitesUsingObs ?? 0,
    transferElites: w.at(-1).v4?.curriculum?.transferElites ?? 0, elapsedMs: r3(mean(w.map((r) => r.elapsedMs))), elapsedMsRef: r3(mean(ref.map((r) => r.elapsedMs))), evaluations: r3(mean(w.map((r) => r.evaluations))),
  });
  if (base && v4) out.ceiling = { ...summarize(v4, base), moved: late(v4, (r) => r.trueValue) > 1.1 * late(base, (r) => r.trueValue) && cum(v4) > cum(base) };
  out.isolated = {};
  for (const [name, key] of [['hindsight', 'v4-hindsight'], ['discovery', 'v4-discovery'], ['discoveryJudgmentsOnly', 'v4-discovery-judgments'], ['obsOps', 'v4-obsops'], ['curriculum', 'v4-curriculum']]) if (base && results[key]) out.isolated[name] = summarize(results[key], base);
  out.ablations = {};
  const all = results['v4-all'] ?? v4;
  for (const [name, key] of [['discovery', 'v4-no-discovery'], ['obsOps', 'v4-no-obsops'], ['curriculum', 'v4-no-curriculum'], ['metaAttention', 'v4-fixed'], ['progressActs', 'v4-progress']]) if (all && results[key]) out.ablations[name] = { ...summarize(all, results[key]), helps: cum(all) > cum(results[key]) };
  return out;
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

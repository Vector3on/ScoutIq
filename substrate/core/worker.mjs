// core/worker.mjs — one heartbeat of the substrate.
//
//   sync-in → project state → plan (attention) → act (sense / evolve / re-test)
//   → select novel, diverse outputs → deliver → measure → sync-out.
//
// Every side effect is an event; every decision is a function of projected
// state plus the seeded RNG, so a run is reproducible from the log and a seed.
import { shortHash, makeRng } from './events.mjs';
import { Ledger } from './ledger.mjs';
import { project, applyLive } from './projections.mjs';
import { memoryProjection, policyProjection, dailyCountsFrom, MemoryVectors, DAY_MS, neighbors, degree, latestSignal, surprisal, burstScore, relationRecord, seriesLatest, seriesFirst } from './memory.mjs';
import { archiveProjection, noveltyOf, strategyEntropy } from './archive.mjs';
import { qdProjection, coverage, qdScore, fitnessOf } from './qd.mjs';
import { makePlannerProjection, estimateCost } from './planner.mjs';
import { selectActions, bucket } from './attention.mjs';
import { runStrategy, describeBehavior, cellOf, DegreeRanks, randomGenome, mutate, mutateStrong, crossover, genomeId, normalizeGenome, canonicalGenomes } from './strategy.mjs';
import { HashEmbedder, cosine } from './embed.mjs';
import { Policy, PolicyError } from '../policy/policy.mjs';
import { pull, push, exportLedger, importLedger } from './sync.mjs';
// v3 addons (DESIGN.md §9) — every one is behind a config flag; with the flags
// off this file emits exactly the v2 event stream.
import { phenotypeOf, SignalRanks } from './phenotype.mjs';
import { makeVqProjection, vqElites, vqOccupied, vqCellId } from './vq.mjs';
import { makeFrontierProjection, initialChallenges, mutateChallenge, regionAccept, challengeFitness, minimalCriterion, activeChallenges, challengeId } from './frontier.mjs';
import { entityFeatures } from './features.mjs';
import { makeValueModelProjection, predictValue, selectJudgments, calibrationMae, posteriorValue } from './valuemodel.mjs';
import { provenanceProjection, assignCredit, makePlannerCreditProjection } from './credit.mjs';
import { makeSentinelProjection, diagnose, nextIntervention, activeInterventions } from './sentinel.mjs';

export const DEFAULTS = Object.freeze({
  budgetSeconds: 60,
  k: 10,
  maxFindings: 20,
  windowDays: 30,
  bins: 6,
  beta: 0.3,
  priorVar: 1.0,
  noiseVar: 0.25,
  forgetting: 0.98,
  maxEvolveCandidates: 40,
  maxCrossovers: 6,
  randomGenomes: 3,
  reevaluateAfterDays: 1,
  maxReevaluate: 8,
  mmrLambda: 0.7,
  hardStopFactor: 1.5,
  maxProposalsPerSensor: 12,
  reserveSense: 0.3,
  reserveThink: 0.3,
  claimTtlMs: 30 * 60 * 1000,
  // ---- v3 addons (off = v2 behaviour) ----
  descriptor: 'fixed',        // 'fixed' | 'learned' | 'both' — which archive supplies parents
  vqTau: 0.45, vqKmax: 256,
  frontier: false, frontierMax: 4, frontierCandidates: 6, frontierTransfers: 2,
  valueModel: false, judgmentsPerRun: 5, activeJudgments: true, judgmentMode: 'ei', vmPriorVar: 0.005, vmNoiseVar: 0.03, vmTokens: false, vmMinTrained: 10,
  vmMode: 'rerank',           // 'rerank': proxy generates candidates, learned model ranks deliveries; 'full': learned model everywhere (= vmSearch 'posterior')
  vmSearch: 'proxy',          // what strategies and fitness see once the model is trained: 'proxy' (raw score: search discovers, judgments confirm), 'override' (judged values win rankings), 'posterior' (learned model everywhere)
  affineCalibration: null,    // v2 affine fit on judgments; null = on unless the learned value model is on (which replaces it)
  judgmentSeeds: null,        // judged, still-novel entities enter the delivery pool by right; null = on when the value model is on
  judgmentSd: 0.15,           // assumed noise of an operator judgment (a judgment is evidence, not truth)
  judgmentSplit: 1.0,         // fraction of the judgment budget chosen by expected improvement; the rest are random calibration probes
  credit: false, creditHops: 1,
  sentinel: false,            // false | 'observe' (diagnose only) | true (diagnose and intervene)
  sentinelWindow: 8, sentinelMinRuns: 12, sentinelCooldown: 6,
  mutationStrength: 1,
});

const HELPERS = Object.freeze({ neighbors, degree, latestSignal, surprisal, burstScore, relationRecord, seriesLatest, seriesFirst, DAY_MS, cosine });

export async function runOnce(opts) {
  const {
    store, hub = null, ledgerDir = null, plugin, domain, node, role = 'worker',
    env = process.env, log = () => {}, wall = () => Date.now(), fetchImpl, sleep,
    policyConfig = {}, seed = null, outDir = null,
  } = opts;
  const cfg = { ...DEFAULTS, ...(opts.config ?? {}) };
  const now = opts.now ?? wall();                 // logical time of this run
  const wallStart = wall();
  const logical = () => now + (wall() - wallStart); // logical clock advancing with real time
  const runId = shortHash(`${node}:${now}:${domain}`).slice(0, 16);
  const rng = makeRng(seed ?? `${runId}`);
  const embedder = new HashEmbedder();

  // 1. sync in ---------------------------------------------------------------
  if (hub) await pull(store, hub, { log });
  if (ledgerDir) await importLedger(store, ledgerDir);

  // 2. project state -----------------------------------------------------------
  const sentinelActs = cfg.sentinel === true;
  const v3 = { phenotype: cfg.descriptor !== 'fixed' || sentinelActs, frontier: !!cfg.frontier || sentinelActs, value: !!cfg.valueModel, credit: !!cfg.credit, sentinel: !!cfg.sentinel };
  const plannerProjection = v3.credit
    ? makePlannerCreditProjection({ priorVar: cfg.priorVar, noiseVar: cfg.noiseVar, forgetting: cfg.forgetting })
    : makePlannerProjection({ priorVar: cfg.priorVar, noiseVar: cfg.noiseVar, forgetting: cfg.forgetting });
  const vqProjection = v3.phenotype ? makeVqProjection({ tau: cfg.vqTau, kmax: cfg.vqKmax }) : null;
  const frontierProjection = v3.frontier ? makeFrontierProjection() : null;
  const valueModelProjection = v3.value ? makeValueModelProjection({ priorVar: cfg.vmPriorVar, noiseVar: cfg.vmNoiseVar }) : null;
  const sentinelProjection = v3.sentinel ? makeSentinelProjection() : null;
  const [mem, arch, qd, plan, pol, vqP, frP, vmP, prP, seP] = await Promise.all([
    project(store, memoryProjection, { domain, log }),
    project(store, archiveProjection, { domain, log }),
    project(store, qdProjection, { domain, log }),
    project(store, plannerProjection, { domain, log }),
    project(store, policyProjection, { domain: undefined, log }),
    vqProjection ? project(store, vqProjection, { domain, log }) : null,
    frontierProjection ? project(store, frontierProjection, { domain, log }) : null,
    valueModelProjection ? project(store, valueModelProjection, { domain, log }) : null,
    v3.credit ? project(store, provenanceProjection, { domain, log }) : null,
    sentinelProjection ? project(store, sentinelProjection, { domain, log }) : null,
  ]);
  const memory = mem.state, archive = arch.state, qdState = qd.state, planner = plan.state, policyState = pol.state;
  const vqState = vqP?.state ?? null, frontierState = frP?.state ?? null, vmState = vmP?.state ?? null, provenance = prP?.state ?? null, sentinelState = seP?.state ?? null;
  const before = { entities: memory.entities.size, obs: memory.obsCount, elites: qdState.elitesReplaced, evaluations: qdState.evaluations, findings: archive.total, vqCells: vqState ? vqOccupied(vqState) : 0 };

  // 3. policy + ledger ---------------------------------------------------------
  let ledger = null;
  const projections = [[memoryProjection, memory, domain], [archiveProjection, archive, domain], [qdProjection, qdState, domain], [plannerProjection, planner, domain], [policyProjection, policyState, undefined]];
  if (vqProjection) projections.push([vqProjection, vqState, domain]);
  if (frontierProjection) projections.push([frontierProjection, frontierState, domain]);
  if (valueModelProjection) projections.push([valueModelProjection, vmState, domain]);
  if (provenance) projections.push([provenanceProjection, provenance, domain]);
  if (sentinelProjection) projections.push([sentinelProjection, sentinelState, domain]);
  const policy = new Policy(policyConfig, {
    env, now: wall, fetchImpl, sleep, log,
    emit: (kind, body) => ledger.emit(kind, body),
    blocks: policyState.blocks, dailyCounts: dailyCountsFrom(policyState, wall()), robotsCache: policyState.robots,
  });
  let memoryDirty = false;
  ledger = new Ledger({
    store, node, policy, domain, now: logical,
    onEvent: (ev) => { for (const [p, s, d] of projections) applyLive(p, s, ev, { domain: d }); if (ev.kind === 'observation.seen') memoryDirty = true; },
  });
  await ledger.init();
  if (hub) { const last = await hub.readSince(Math.max(0, (await hub.maxIngestSeq()) - 1), 1); if (last[0]) ledger.observeClock(last[0].hlc); }

  const manifests = new Map();
  for (const s of plugin.sensors) manifests.set(s.id, policy.registerManifest(s.manifest));
  await ledger.emit('plugin.loaded', { plugin: plugin.id, version: plugin.version ?? null, sensors: plugin.sensors.map((s) => s.id), node, role });
  await ledger.emit('run.started', { runId, domain, node, role, now, budgetSeconds: cfg.budgetSeconds, plugin: plugin.id });

  // 3b. v3: sentinel — apply live interventions, diagnose, intervene ------------
  let sentinelInfo = null;
  if (sentinelState) {
    const applyIntervention = (i) => {
      if (i.action === 'temperature') { cfg.randomGenomes = Math.max(cfg.randomGenomes, i.params.randomGenomes ?? 8); cfg.mutationStrength = Math.max(cfg.mutationStrength, i.params.mutationStrength ?? 2); }
      else if (i.action === 'descriptor') { if (vqState && vqOccupied(vqState) > 0) cfg.descriptor = cfg.descriptor === 'fixed' ? 'both' : cfg.descriptor; cfg.maxEvolveCandidates = Math.max(cfg.maxEvolveCandidates, i.params.maxEvolveCandidates ?? 60); }
    };
    for (const i of activeInterventions(sentinelState)) applyIntervention(i);
    const diag = diagnose(sentinelState, { window: cfg.sentinelWindow, minRuns: cfg.sentinelMinRuns });
    let intervention = null;
    if (diag.stagnant && sentinelActs) {
      intervention = nextIntervention(sentinelState, { cooldown: cfg.sentinelCooldown });
      if (intervention && intervention.action === 'frontier' && !frontierState) intervention = { ...intervention, action: 'temperature', params: { randomGenomes: 8, mutationStrength: 2 } };
      if (intervention) {
        await ledger.emit('sentinel.intervened', { runId, trigger: diag, action: intervention.action, params: intervention.params, ttlRuns: intervention.ttlRuns, ts: now });
        applyIntervention({ ...intervention, atIndex: sentinelState.runIndex });
      }
    }
    sentinelInfo = { ...diag, intervention: intervention?.action ?? null, active: activeInterventions(sentinelState).map((i) => i.action) };
  }

  // 3c. v3: frontier — minimal criterion, spawn/retire challenges ---------------
  if (frontierState && (cfg.frontier || sentinelInfo?.active?.includes('frontier') || sentinelInfo?.intervention === 'frontier')) {
    const fr = rng.fork('frontier');
    for (const ch of activeChallenges(frontierState)) {
      const verdict = minimalCriterion(ch);
      if (verdict === 'active') continue;
      await ledger.emit('challenge.retired', { challengeId: ch.id, reason: verdict, runId, ts: now });
      if (verdict === 'solved' && activeChallenges(frontierState).length < cfg.frontierMax) {
        const spec = mutateChallenge(ch.spec, fr, plugin.schema, { harder: true });
        const id = challengeId(spec);
        if (!frontierState.challenges.has(id)) await ledger.emit('challenge.created', { challengeId: id, spec, parent: ch.id, origin: 'solved', runId, ts: now });
      }
    }
    const wantNew = (sentinelInfo?.intervention === 'frontier' ? 1 : 0) + Math.max(0, 2 - activeChallenges(frontierState).length);
    for (let i = 0; i < wantNew && activeChallenges(frontierState).length < cfg.frontierMax; i++) {
      const fresh = initialChallenges(plugin.schema).filter((spec) => !frontierState.challenges.has(challengeId(spec)));
      const retiredPool = [...frontierState.challenges.values()].filter((c) => c.status !== 'active');
      let spec = fresh.length ? fresh[0] : mutateChallenge(fr.pick(retiredPool).spec, fr, plugin.schema);
      for (let t = 0; t < 5 && frontierState.challenges.has(challengeId(spec)); t++) spec = mutateChallenge(spec, fr, plugin.schema);
      const id = challengeId(spec);
      if (frontierState.challenges.has(id)) break;
      await ledger.emit('challenge.created', { challengeId: id, spec, parent: null, origin: sentinelInfo?.intervention === 'frontier' ? 'sentinel' : 'schedule', runId, ts: now });
    }
  }

  // 4. value function + vectors ----------------------------------------------
  let vectors = new MemoryVectors(memory, embedder);
  let degreeRanks = new DegreeRanks(memory);
  let signalRanks = v3.phenotype || v3.value ? new SignalRanks(memory, plugin.schema.signals) : null;
  const valueCache = new Map();
  const featureCache = new Map();
  const useAffine = cfg.affineCalibration ?? !cfg.valueModel;
  const calibration = useAffine ? fitCalibration(archive, (id) => rawValue(id)) : null;
  function featuresOf(id) {
    if (featureCache.has(id)) return featureCache.get(id);
    const f = entityFeatures(id, { memory, schema: plugin.schema, now, degreeRanks, signalRanks, pluginScore: rawValue(id), tokens: cfg.vmTokens });
    featureCache.set(id, f);
    return f;
  }
  function rawValue(id) {
    const e = memory.entities.get(id);
    if (!e) return 0;
    let v = Number(plugin.value.score(e, { memory, now, vectors, helpers: HELPERS, domain }));
    if (!Number.isFinite(v)) v = 0;
    return Math.max(0, Math.min(1, v));
  }
  const learnedReady = () => !!(vmState && vmState.trained >= cfg.vmMinTrained);
  function valueOf(id) {
    if (valueCache.has(id)) return valueCache.get(id);
    const j = archive.judgments.get(id);
    const search = cfg.vmMode === 'full' ? 'posterior' : cfg.vmSearch;
    let v;
    if (learnedReady() && search === 'posterior') v = deliveryValue(id); // one scale for everyone: the learned model, judgments as evidence
    else if (j && !(learnedReady() && search === 'proxy')) v = Math.max(0, Math.min(1, Number(j.value))); // v2 semantics: a judgment overrides
    else { v = rawValue(id); if (calibration) v = Math.max(0, Math.min(1, calibration.a + calibration.b * v)); }
    valueCache.set(id, v);
    return v;
  }
  /** v3: the value used to rank deliveries — the learned model, combined with a judgment when one exists. */
  function deliveryValue(id) {
    const j = archive.judgments.get(id);
    if (learnedReady()) {
      const f = featuresOf(id), raw = rawValue(id);
      return j ? posteriorValue(vmState, f, raw, Math.max(0, Math.min(1, Number(j.value))), { judgmentSd: cfg.judgmentSd }).value : predictValue(vmState, f, raw).value;
    }
    if (j) return Math.max(0, Math.min(1, Number(j.value)));
    return valueOf(id);
  }
  function refreshDerived() {
    if (!memoryDirty) return;
    vectors = new MemoryVectors(memory, embedder);
    degreeRanks = new DegreeRanks(memory);
    if (signalRanks) signalRanks = new SignalRanks(memory, plugin.schema.signals);
    valueCache.clear();
    featureCache.clear();
    memoryDirty = false;
  }
  const recentVecs = archive.recent.slice(-200).map((f) => (vectors.space === 'hash' ? (f.title ? vectors.embedText(f.title) : null) : vectors.get(f.entityId))).filter(Boolean);

  // 5. candidates ---------------------------------------------------------------
  const candidates = [];
  for (const sensor of plugin.sensors) {
    const stats = planner.sensorStats.get(sensor.id) ?? new Map();
    const manifest = manifests.get(sensor.id);
    const interval = manifest.endpoints.length ? Math.max(...manifest.endpoints.map((e) => e.minIntervalMs)) / 1000 : 0;
    let proposals = [];
    try { proposals = (await sensor.propose({ memory, stats, now, rng: rng.fork(`propose:${sensor.id}`), limit: cfg.maxProposalsPerSensor, helpers: HELPERS })) ?? []; }
    catch (e) { log(`propose failed for ${sensor.id}: ${e.message}`); }
    for (const p of proposals.slice(0, cfg.maxProposalsPerSensor)) {
      const paramsKey = p.paramsKey ?? shortHash(p.params ?? {}).slice(0, 12);
      // stigmergy: another worker holds a live lease on this poll → leave it to them
      const claim = policyState.claims.get(`${sensor.id}:${paramsKey}`);
      if (claim && claim.node !== node && claim.until > wall()) continue;
      const st = stats.get(paramsKey);
      const staleDays = st ? (now - st.lastAt) / DAY_MS : 999;
      const declared = p.estSeconds ?? Math.max(1, p.estRequests ?? 1) * (interval + 0.5);
      candidates.push({
        id: `poll:${sensor.id}:${paramsKey}`, type: 'poll', sensor, params: p.params ?? {}, paramsKey,
        features: { type: 'poll', sensor: sensor.id, ...(p.features ?? {}), stale: bucket(staleDays, [0.5, 1, 3, 7, 30]), lastY: st ? bucket(st.lastY, [0.1, 0.3, 0.6]) : 'none', polls: bucket(st?.polls ?? 0, [1, 3, 10]) },
        cost: Math.max(declared, estimateCost(planner, `poll:${sensor.id}`, declared)),
      });
    }
  }
  const evolveCost = estimateCost(planner, 'evolve', 0.3);
  const fixedCells = [...qdState.cells.entries()].map(([cell, e]) => ({ cell, ...e, curiosity: qdState.curiosity.get(cell) ?? 0 })).sort((a, b) => b.curiosity - a.curiosity || b.fitness - a.fitness);
  // v3: the learned archive can supply parents instead of / alongside the fixed grid
  const learnedCells = vqState && cfg.descriptor !== 'fixed' ? vqElites(vqState).map((e) => ({ ...e, bd: null })).sort((a, b) => b.curiosity - a.curiosity || b.fitness - a.fitness) : [];
  let cells;
  if (cfg.descriptor === 'learned' && learnedCells.length) cells = learnedCells;
  else if (cfg.descriptor === 'both' && learnedCells.length) cells = interleave(fixedCells, learnedCells);
  else cells = fixedCells;
  for (const c of cells.slice(0, cfg.maxEvolveCandidates)) {
    candidates.push({ id: `evolve:${c.cell}`, type: 'evolve', parentCell: c.cell, parent: c, features: { type: 'evolve', cell: c.cell, learned: c.cell.startsWith('vq:'), cur: bucket(c.curiosity, [0.5, 1.5, 3]), fit: bucket(c.fitness, [0.05, 0.15, 0.3]), age: bucket((now - c.ts) / DAY_MS, [1, 3, 10]), size: bucket(1 + (c.genome.pipe?.length ?? 0), [2, 3, 4]) }, cost: evolveCost });
  }
  if (cells.length >= 2) {
    const xr = rng.fork('xover');
    for (let i = 0; i < cfg.maxCrossovers; i++) {
      const a = xr.pick(cells), b = xr.pick(cells);
      if (a.cell === b.cell) continue;
      const dist = a.bd && b.bd ? Math.abs(a.bd.age - b.bd.age) + Math.abs(a.bd.centrality - b.bd.centrality) + Math.abs(a.bd.spread - b.bd.spread) : 1;
      candidates.push({ id: `xover:${a.cell}:${b.cell}`, type: 'crossover', parentA: a, parentB: b, features: { type: 'crossover', fitA: bucket(a.fitness, [0.05, 0.15, 0.3]), fitB: bucket(b.fitness, [0.05, 0.15, 0.3]), dist: bucket(dist, [0.3, 0.8, 1.5]) }, cost: evolveCost });
    }
  }
  const nRandom = cells.length ? cfg.randomGenomes : Math.max(cfg.randomGenomes, 6);
  for (let i = 0; i < nRandom; i++) candidates.push({ id: `random:${i}`, type: 'random', features: { type: 'random', archive: bucket(cells.length, [1, 10, 50]) }, cost: evolveCost });
  const stale = cells.filter((c) => (now - c.ts) / DAY_MS >= cfg.reevaluateAfterDays).sort((a, b) => a.ts - b.ts).slice(0, cfg.maxReevaluate);
  for (const c of stale) candidates.push({ id: `reeval:${c.cell}`, type: 'reevaluate', parent: c, parentCell: c.cell, features: { type: 'reevaluate', stale: bucket((now - c.ts) / DAY_MS, [1, 3, 10]), fit: bucket(c.fitness, [0.05, 0.15, 0.3]) }, cost: evolveCost });
  // v3: frontier candidates — evaluate inside challenges, and transfer challenge elites into the main archive
  if (frontierState && (cfg.frontier || cfg.descriptor !== 'fixed' || sentinelState)) {
    const fr = rng.fork('frontier-cands');
    const active = activeChallenges(frontierState);
    let n = 0;
    for (const ch of fr.shuffle(active)) {
      for (let i = 0; i < 2 && n < cfg.frontierCandidates; i++, n++) {
        const mode = ch.elites.length && fr() < 0.6 ? 'mutation' : cells.length && fr() < 0.7 ? 'transfer-in' : 'random';
        candidates.push({ id: `frontier:${ch.id}:${i}`, type: 'frontier', challenge: ch, mode, features: { type: 'frontier', minValue: bucket(ch.spec.minValue, [0.3, 0.5, 0.7]), band: `${ch.spec.region?.ageMin ?? '-'}..${ch.spec.region?.ageMax ?? '-'}`, evals: bucket(ch.evaluations, [3, 10, 30]), best: bucket(ch.best, [0.02, 0.1, 0.2]), mode }, cost: evolveCost });
      }
    }
    let t = 0;
    for (const ch of [...frontierState.challenges.values()].sort((a, b) => b.best - a.best)) {
      for (const e of ch.elites.slice(0, 2)) {
        if (t >= cfg.frontierTransfers) break;
        const g = qdState.genomes.get(e.genomeId);
        if (g && g.evals > 0 && (now - g.lastTs) / DAY_MS < 7) continue; // already tried in the main archive recently
        candidates.push({ id: `transfer:${ch.id}:${e.genomeId}`, type: 'transfer', genome: e.genome, challenge: ch, elite: e, features: { type: 'transfer', fit: bucket(e.fitness, [0.05, 0.15, 0.3]), minValue: bucket(ch.spec.minValue, [0.3, 0.5, 0.7]) }, cost: evolveCost });
        t++;
      }
    }
  }
  const forced = [];
  if (qdState.evaluations === 0) for (const [i, g] of canonicalGenomes(plugin.schema).entries()) forced.push({ id: `canonical:${i}`, type: 'seeded', genome: g, kind: 'canonical', features: { type: 'seeded', canonical: true }, cost: evolveCost });
  for (const s of archive.seeded) if (!qdState.genomes.has(genomeId(normalizeGenome(s.genome)))) forced.push({ id: `seeded:${s.id}`, type: 'seeded', genome: normalizeGenome(s.genome), kind: 'seeded', features: { type: 'seeded', canonical: false }, cost: evolveCost });

  // 6. attention: select under budget --------------------------------------------
  const selection = selectActions(candidates, {
    model: planner.model, rng: rng.fork('select'), beta: cfg.beta, budget: cfg.budgetSeconds,
    reserve: [{ match: (c) => c.type === 'poll', fraction: cfg.reserveSense }, { match: (c) => c.type !== 'poll', fraction: cfg.reserveThink }],
  });
  // Sense before you think: polls change memory; evaluations read it.
  const chosen = [...selection.chosen.filter((c) => c.type === 'poll'), ...forced, ...selection.chosen.filter((c) => c.type !== 'poll')];
  await ledger.emit('action.planned', {
    runId, candidates: candidates.length, chosen: chosen.length, budgetSeconds: cfg.budgetSeconds, estimatedSeconds: selection.used,
    top: selection.chosen.slice(0, 25).map((c) => ({ id: c.id, score: round(c.score), exploit: round(c.exploit), ig: round(c.ig), cost: round(c.cost) })),
  });

  // 7. act ------------------------------------------------------------------------
  const pool = new Map();
  const counters = { byType: {}, executed: 0, newObservations: 0, observations: 0, evaluations: 0, denials: 0, blocked: 0, igSum: 0, exploitSum: 0 };
  const restoreFetch = policy.installGlobalFetchGuard();
  try {
    for (const action of chosen) {
      if ((wall() - wallStart) / 1000 > cfg.budgetSeconds * cfg.hardStopFactor) { log('hard stop: budget exceeded'); break; }
      const t0 = wall();
      counters.byType[action.type] = (counters.byType[action.type] ?? 0) + 1;
      counters.executed++;
      counters.igSum += action.ig ?? 0; counters.exploitSum += action.exploit ?? 0;
      let raw = 0, extra = {};
      try {
        if (action.type === 'poll') {
          const r = await executePoll(action);
          raw = r.raw; extra = r.extra;
        } else if (action.type === 'frontier') {
          refreshDerived();
          const r = await executeChallenge(action);
          raw = r.raw; extra = r.extra;
        } else {
          refreshDerived();
          const r = await executeEvolution(action);
          raw = r.raw; extra = r.extra;
        }
      } catch (e) {
        if (e instanceof PolicyError) { counters.denials++; extra = { denied: e.code }; log(`denied: ${e.message}`); }
        else { extra = { error: String(e.message).slice(0, 200) }; log(`action ${action.id} failed: ${e.stack ?? e.message}`); }
      }
      const ms = wall() - t0;
      await ledger.emit('action.outcome', { runId, type: action.type === 'poll' ? `poll:${action.sensor.id}` : action.type, actionId: action.id, features: action.features, raw: round(raw, 5), ms, ts: now, ...extra });
    }
  } finally {
    restoreFetch();
  }

  async function executePoll(action) {
    const sensor = action.sensor, manifest = manifests.get(sensor.id);
    let res;
    await ledger.emit('task.claimed', { key: `${sensor.id}:${action.paramsKey}`, node, until: wall() + cfg.claimTtlMs });
    const scope = policy.network.enterScope(sensor.id, { domain });
    try {
      res = await sensor.poll(action.params, { fetch: (u, o) => policy.network.fetchGuarded(u, o), now, log, memory, pseudonym: policy.hasSalt ? (s) => policy.pseudonym(s) : null, helpers: HELPERS, rng: rng.fork(`poll:${action.id}`) });
    } finally { policy.network.exitScope(); }
    const observations = res?.observations ?? [];
    let newObs = 0, raw = 0;
    for (const obs of observations) {
      const body = { sensor: sensor.id, externalId: String(obs.externalId), observedAt: Number.isFinite(obs.observedAt) ? obs.observedAt : now, text: obs.text ?? null, entities: obs.entities ?? [], relations: obs.relations ?? [], params: action.paramsKey };
      const content = shortHash({ e: body.entities, r: body.relations, t: body.text }).slice(0, 16);
      const dedupKey = `obs:${sensor.id}:${body.externalId}:${content}:${Math.floor(body.observedAt / DAY_MS)}`;
      const ev = await ledger.emit('observation.seen', body, { dedupKey, personFields: manifest.personFields, skipIfDedupKeyExists: true });
      if (ev) {
        newObs++;
        // Credit the poll with the value of what it brought: the plug-in's own
        // observation scorer if it has one, else the (live) value of the primary entity.
        let ov;
        if (plugin.value.observation) ov = Number(plugin.value.observation(obs, { memory, now, helpers: HELPERS }));
        else { const first = body.entities[0]; valueCache.delete(first ? `${first.type}:${first.key}` : ''); ov = first ? valueOf(`${first.type}:${first.key}`) : 0; }
        raw += Number.isFinite(ov) ? Math.max(0, Math.min(1, ov)) : 0;
      }
    }
    counters.observations += observations.length;
    counters.newObservations += newObs;
    if (scope.requests) counters.blocked += policy.network.isBlocked(new URL(`https://${manifest.endpoints[0]?.host ?? 'localhost'}`).hostname) ? 1 : 0;
    return { raw, extra: { sensor: sensor.id, paramsKey: action.paramsKey, obs: observations.length, newObs, requests: scope.requests, blocked: !!res?.blocked } };
  }

  async function executeEvolution(action) {
    const schema = plugin.schema;
    const r = rng.fork(`evo:${action.id}:${counters.executed}`);
    let genome, kind, parent = null, vqParent = null, origin = null;
    const fixedCellOf = (c) => (c.cell.startsWith('vq:') ? c.fixedCell ?? null : c.cell);
    if (action.type === 'evolve') { genome = mutateStrong(action.parent.genome, schema, r, cfg.mutationStrength); kind = 'mutation'; parent = { genomeId: action.parent.genomeId, cell: fixedCellOf(action.parent) }; vqParent = { genomeId: action.parent.genomeId, cell: action.parentCell }; }
    else if (action.type === 'crossover') { genome = crossover(action.parentA.genome, action.parentB.genome, r); kind = 'crossover'; parent = { genomeId: action.parentA.genomeId, cell: fixedCellOf(action.parentA) }; vqParent = { genomeId: action.parentA.genomeId, cell: action.parentA.cell }; }
    else if (action.type === 'reevaluate') { genome = action.parent.genome; kind = 'reevaluate'; parent = null; }
    else if (action.type === 'seeded') { genome = action.genome; kind = action.kind ?? 'seeded'; }
    else if (action.type === 'transfer') { genome = action.genome; kind = 'transfer'; origin = action.challenge.id; }
    else { genome = randomGenome(schema, r); kind = 'random'; }
    const result = evaluateGenome(genome, kind, parent);
    counters.evaluations++;
    await ledger.emit('strategy.evaluated', { runId, genomeId: result.genomeId, genome, fitness: round(result.fitness, 5), bd: result.bd, cell: result.cell, bins: cfg.bins, parent, kind, nOut: result.findings.length, ts: now, top: result.findings.slice(0, 3).map((f) => ({ entityId: f.entityId, score: round(f.score) })), ...(origin ? { origin } : {}) });
    if (v3.phenotype) {
      const ph = phenotypeOf(result.items, { memory, vectors, now, schema, degreeRanks, signalRanks, findings: result.findings });
      await ledger.emit('strategy.phenotype', { runId, genomeId: result.genomeId, genome, fitness: round(result.fitness, 5), phenotype: ph?.vec ?? null, fixedCell: result.cell, parent: vqParent ?? parent, kind, nOut: result.findings.length, ts: now });
    }
    for (const f of result.findings) {
      if (f.hard !== 1 || f.score <= 0) continue;
      const prev = pool.get(f.entityId);
      if (!prev || prev.score < f.score) pool.set(f.entityId, { ...f, strategyId: result.genomeId, cell: result.cell, genome });
    }
    return { raw: Math.max(0, result.fitness), extra: { genomeId: result.genomeId, kind, fitness: round(result.fitness, 5), cell: result.cell, nOut: result.findings.length } };
  }

  function evaluateGenome(genome, kind, parent) {
    const ctx = { memory, vectors, now, value: valueOf, k: cfg.k, isNovel: (id) => noveltyOf(archive, { entityId: id, now, windowDays: cfg.windowDays }).hard === 1 };
    const out = runStrategy(genome, ctx);
    const findings = out.items.map((it) => {
      const value = valueOf(it.id);
      const nov = noveltyOf(archive, { entityId: it.id, vec: vectors.get(it.id), now, windowDays: cfg.windowDays, recentVecs });
      return { entityId: it.id, value, novelty: nov.novelty, hard: nov.hard, score: value * nov.novelty, rationale: it.rationale, rankScore: it.rankScore };
    });
    const fitness = fitnessOf(findings, cfg.k, genome);
    const bd = describeBehavior(out.items, ctx, degreeRanks);
    return { genomeId: genomeId(normalizeGenome(genome)), fitness, bd, cell: cellOf(bd, cfg.bins), findings, kind, parent, items: out.items };
  }

  /** v3: evaluate a genome inside a frontier challenge (region + value bar). */
  async function executeChallenge(action) {
    const ch = action.challenge, schema = plugin.schema;
    const r = rng.fork(`challenge:${action.id}:${counters.executed}`);
    let genome, parent = null;
    if (action.mode === 'mutation' && ch.elites.length) { const e = r.pick(ch.elites); genome = mutateStrong(e.genome, schema, r, cfg.mutationStrength); parent = { genomeId: e.genomeId, cell: ch.id }; }
    else if (action.mode === 'transfer-in' && cells.length) { const c = r.pick(cells.slice(0, 20)); genome = c.genome; parent = { genomeId: c.genomeId, cell: c.cell }; }
    else genome = randomGenome(schema, r);
    const accept = regionAccept(ch.spec, memory, now);
    const ctx = { memory, vectors, now, value: valueOf, k: cfg.k, isNovel: (id) => noveltyOf(archive, { entityId: id, now, windowDays: cfg.windowDays }).hard === 1, accept };
    const out = runStrategy(genome, ctx);
    const findings = out.items.map((it) => {
      const value = valueOf(it.id);
      const nov = noveltyOf(archive, { entityId: it.id, vec: vectors.get(it.id), now, windowDays: cfg.windowDays, recentVecs });
      return { entityId: it.id, value, novelty: nov.novelty, hard: nov.hard, score: value * nov.novelty, rationale: it.rationale, rankScore: it.rankScore };
    });
    const fitness = challengeFitness(findings, cfg.k, genome, ch.spec);
    const gid = genomeId(normalizeGenome(genome));
    counters.evaluations++;
    await ledger.emit('challenge.evaluated', { challengeId: ch.id, runId, genomeId: gid, genome, fitness: round(fitness, 5), kind: action.mode, parent, nOut: findings.length, ts: now });
    for (const f of findings) {
      if (f.hard !== 1 || f.score <= 0 || f.value < ch.spec.minValue) continue;
      const prev = pool.get(f.entityId);
      if (!prev || prev.score < f.score) pool.set(f.entityId, { ...f, strategyId: gid, cell: ch.id, genome });
    }
    return { raw: Math.max(0, fitness), extra: { genomeId: gid, kind: `frontier:${action.mode}`, fitness: round(fitness, 5), challenge: ch.id, nOut: findings.length } };
  }

  // 8. select outputs: novel, valuable, diverse ------------------------------------
  refreshDerived();
  if (cfg.judgmentSeeds ?? !!cfg.valueModel) {
    // v3: an operator judgment is an observation of value — a judged, still-novel entity is a candidate by right
    for (const [id, j] of archive.judgments) {
      if (pool.has(id) || !memory.entities.has(id)) continue;
      const nov = noveltyOf(archive, { entityId: id, vec: vectors.get(id), now, windowDays: cfg.windowDays, recentVecs });
      if (nov.hard !== 1) continue;
      const value = deliveryValue(id);
      if (value * nov.novelty <= 0) continue;
      pool.set(id, { entityId: id, value, novelty: nov.novelty, hard: 1, score: value * nov.novelty, rationale: [`judged ${Number(j.value).toFixed(2)} by ${j.by ?? 'operator'}`], rankScore: value, strategyId: 'judgment', cell: null, genome: null });
    }
  }
  if (learnedReady() && cfg.vmMode === 'rerank') for (const f of pool.values()) { if (f.strategyId === 'judgment') continue; f.value = deliveryValue(f.entityId); f.score = f.value * f.novelty; } // v3: re-rank with the learned model
  const outputs = selectOutputs([...pool.values()], { vectors, max: cfg.maxFindings, lambda: cfg.mmrLambda });
  const findings = [];
  for (const f of outputs) {
    const e = memory.entities.get(f.entityId);
    const title = (e?.text ? e.text.slice(0, 140) : e?.key) ?? f.entityId;
    const findingId = shortHash({ runId, entityId: f.entityId }).slice(0, 16);
    const body = { findingId, runId, domain, entityId: f.entityId, entityType: e?.type ?? null, title, score: round(f.score, 4), value: round(f.value, 4), novelty: round(f.novelty, 4), strategyId: f.strategyId, cell: f.cell, rationale: f.rationale.slice(0, 6), ts: now, attrs: compactAttrs(e) };
    await ledger.emit('finding.emitted', body);
    findings.push(body);
  }
  for (const sink of plugin.sinks ?? []) {
    try { await sink.emit(findings, { runId, domain, memory, now, outDir }); }
    catch (e) { log(`sink ${sink.id} failed: ${e.message}`); }
  }

  // 8b. v3: value model — features for what we showed, and ask for the most informative judgments
  let judgmentRequest = null;
  if (vmState) {
    const delivered = new Set(findings.map((f) => f.entityId));
    const cands = [...pool.values()].sort((a, b) => b.score - a.score).slice(0, Math.max(cfg.maxFindings * 4, 60)).map((f) => ({ entityId: f.entityId, features: featuresOf(f.entityId), pluginScore: rawValue(f.entityId), score: f.score, findingId: findings.find((x) => x.entityId === f.entityId)?.findingId ?? null }));
    const cutoff = findings.length >= cfg.maxFindings ? Math.min(...findings.map((f) => f.score)) : 0;
    // The decision a judgment informs is NEXT run's delivery: only undelivered candidates are worth the operator's budget.
    let picked;
    if (cfg.activeJudgments) {
      const undelivered = cands.filter((c) => !delivered.has(c.entityId));
      const kEi = Math.round(cfg.judgmentsPerRun * Math.max(0, Math.min(1, cfg.judgmentSplit)));
      picked = selectJudgments(vmState, undelivered, { k: kEi, mode: cfg.judgmentMode, cutoff, judgmentSd: cfg.judgmentSd });
      // calibration probes: uniformly random unjudged candidates keep the value model's training sample unbiased
      const taken = new Set(picked.map((c) => c.entityId));
      const probes = rng.fork('probes').shuffle(undelivered.filter((c) => !taken.has(c.entityId) && !vmState.judged.has(c.entityId))).slice(0, cfg.judgmentsPerRun - kEi);
      picked = [...picked, ...probes.map((c) => ({ ...c, ig: 0, priority: 0, probe: true }))];
    } else {
      picked = cands.filter((c) => delivered.has(c.entityId) && !vmState.judged.has(c.entityId)).slice(0, cfg.judgmentsPerRun).map((c) => ({ ...c, ig: 0 }));
    }
    const need = new Map();
    for (const c of cands) if (delivered.has(c.entityId)) need.set(c.entityId, c);
    for (const c of picked) need.set(c.entityId, c);
    for (const c of need.values()) await ledger.emit('value.features', { runId, entityId: c.entityId, features: c.features, pluginScore: round(c.pluginScore, 4), ts: now });
    if (picked.length) {
      judgmentRequest = picked.map((c) => ({ entityId: c.entityId, findingId: c.findingId, title: (memory.entities.get(c.entityId)?.text ?? c.entityId).slice(0, 140), score: round(c.score, 4), ig: round(c.ig, 4), priority: round(c.priority ?? 0, 4), reason: c.probe ? 'calibration probe (random)' : cfg.activeJudgments ? (cfg.judgmentMode === 'ei' ? 'highest expected improvement over the delivery cutoff' : 'most informative for the value model') : 'top delivered' }));
      await ledger.emit('judgment.requested', { runId, items: judgmentRequest, ts: now });
    }
  }

  // 8c. v3: delayed credit — pay the polls that made each finding possible
  let credited = 0;
  if (provenance) {
    for (const f of findings) {
      for (const c of assignCredit(f, { provenance, memory, now, hops: cfg.creditHops }).slice(0, 6)) {
        await ledger.emit('credit.assigned', { runId, findingId: f.findingId, entityId: f.entityId, sensor: c.sensor, paramsKey: c.paramsKey, amount: c.amount, weight: c.weight, hops: c.hops, features: c.features, type: c.type, ts: now });
        credited++;
      }
    }
  }

  // 9. measure ----------------------------------------------------------------------
  const elapsedMs = wall() - wallStart;
  const distinctStrategies = new Set(findings.map((f) => f.strategyId)).size;
  const judged = [...archive.judgments.values()].filter((j) => j.entityId && memory.entities.has(j.entityId));
  const calib = judged.length ? { n: judged.length, mae: round(judged.reduce((s, j) => s + Math.abs(rawValue(j.entityId) - j.value), 0) / judged.length, 4) } : null;
  const summary = {
    runId, domain, node, role, startedAt: now, elapsedMs, budgetSeconds: cfg.budgetSeconds, estimatedSeconds: round(selection.used, 2),
    candidates: candidates.length, chosen: chosen.length, executed: counters.executed, byType: counters.byType,
    requests: policy.network.runCounts.total, denials: counters.denials + policy.network.denials.length, activeBlocks: policy.network.summary().blocks.length,
    observations: counters.observations, newObservations: counters.newObservations, entities: memory.entities.size, relations: memory.relations.size, newEntities: memory.entities.size - before.entities,
    evaluations: counters.evaluations, newElites: qdState.elitesReplaced - before.elites, archiveCells: qdState.cells.size, coverage: round(coverage(qdState), 4), qdScore: round(qdScore(qdState), 4),
    findings: findings.length, poolSize: pool.size, novelValue: round(findings.reduce((s, f) => s + f.score, 0), 4), meanNovelty: round(mean(findings.map((f) => f.novelty)), 4), meanValue: round(mean(findings.map((f) => f.value)), 4),
    strategyEntropy: round(strategyEntropy(archive), 4), distinctStrategies, calibration: calib,
    attention: { meanIg: round(counters.executed ? counters.igSum / counters.executed : 0, 4), meanExploit: round(counters.executed ? counters.exploitSum / counters.executed : 0, 4), outcomes: planner.outcomes },
    valuePerSecond: round(findings.reduce((s, f) => s + f.score, 0) / Math.max(1, cfg.budgetSeconds), 5),
  };
  if (vqState) summary.vq = { cells: vqOccupied(vqState), centroids: vqState.centroids.length, tau: round(vqState.tau, 4), newCells: vqOccupied(vqState) - before.vqCells, descriptor: cfg.descriptor };
  if (frontierState) summary.frontier = { active: activeChallenges(frontierState).length, total: frontierState.challenges.size, solved: frontierState.solved, retired: frontierState.retired, evaluations: frontierState.evaluations, transfers: frontierState.transfers, transferElites: [...qdState.cells.values()].filter((c) => c.kind === 'transfer').length };
  if (vmState) summary.valueModel = { trained: vmState.trained, mae: calibrationMae(vmState) === null ? null : round(calibrationMae(vmState), 4), requested: judgmentRequest?.length ?? 0, active: !!cfg.activeJudgments };
  if (provenance) summary.credit = { credited, total: planner.credited ?? 0 };
  if (sentinelInfo) summary.sentinel = sentinelInfo;
  await ledger.emit('run.completed', summary);

  // 10. snapshots + sync out ------------------------------------------------------------
  const maxIngest = await store.maxIngestSeq();
  const watermark = ledger.clock.wall ? `${ledger.clock.wall.toString(16).padStart(12, '0')}-${ledger.clock.logical.toString(16).padStart(4, '0')}-${node}` : '';
  for (const [p, s, d] of projections) await store.putSnapshot({ name: `${p.name}:${d ?? '*'}`, version: p.version, watermark, ingestSeq: maxIngest, state: p.dehydrate(s), builtAt: Date.now() });
  if (hub) await push(store, hub, { log });
  if (ledgerDir) await exportLedger(store, ledgerDir);
  return { summary, findings, denials: policy.network.denials, blocks: policy.network.summary().blocks, pool: [...pool.values()].map((f) => ({ entityId: f.entityId, score: f.score, value: f.value, strategyId: f.strategyId })) };
}

function selectOutputs(pool, { vectors, max, lambda }) {
  const items = pool.filter((f) => f.score > 0).sort((a, b) => b.score - a.score || (a.entityId < b.entityId ? -1 : 1));
  const chosen = [];
  const vecs = new Map(items.map((f) => [f.entityId, vectors.get(f.entityId)]));
  while (chosen.length < max && items.length) {
    let best = null, bestVal = -Infinity, bestIdx = -1;
    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      let sim = 0;
      const v = vecs.get(f.entityId);
      for (const c of chosen) {
        let s = v && vecs.get(c.entityId) ? Math.max(0, cosine(v, vecs.get(c.entityId))) : 0;
        if (c.strategyId === f.strategyId) s = Math.max(s, 0.25);
        if (s > sim) sim = s;
      }
      const val = lambda * f.score - (1 - lambda) * sim;
      if (val > bestVal) { bestVal = val; best = f; bestIdx = i; }
    }
    chosen.push(best);
    items.splice(bestIdx, 1);
  }
  return chosen;
}

/** Least-squares affine calibration predicted → judged, if ≥ 5 judgments exist. */
function fitCalibration(archive, rawValue) {
  const pts = [];
  for (const j of archive.judgments.values()) {
    if (!j.entityId) continue;
    const x = rawValue(j.entityId);
    if (Number.isFinite(x)) pts.push([x, Math.max(0, Math.min(1, Number(j.value)))]);
  }
  if (pts.length < 5) return null;
  const n = pts.length, mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0, sxx = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) * (x - mx); }
  if (sxx < 1e-9) return null;
  const b = Math.max(0.2, Math.min(3, sxy / sxx));
  return { a: my - b * mx, b, n };
}

function compactAttrs(e) {
  if (!e) return null;
  const out = {};
  for (const [k, v] of Object.entries(e.attrs ?? {}).slice(0, 8)) out[k] = typeof v === 'string' ? v.slice(0, 80) : v;
  const sig = {};
  for (const [k, s] of e.signals) { const p = seriesLatest(s); if (p) sig[k] = p[1]; }
  return { ...out, signals: sig, firstSeen: e.firstSeen, lastSeen: e.lastSeen, n: e.n };
}
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const round = (x, d = 3) => (Number.isFinite(x) ? Number(Number(x).toFixed(d)) : 0);
function interleave(a, b) {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) { if (i < a.length) out.push(a[i]); if (i < b.length) out.push(b[i]); }
  return out;
}

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
import { runStrategy, describeBehavior, cellOf, DegreeRanks, randomGenome, mutate, mutateStrong, crossover, genomeId, normalizeGenome, canonicalGenomes, OBS_OP, OBS_SEED } from './strategy.mjs';
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
// v4 addons (DESIGN.md §10) — hindsight labels, learned observables, retrospective curriculum, learning progress.
// Each is a config flag; with the flags off this file emits exactly the v3 event stream.
import { pastRuns, memoryAsOf } from './timetravel.mjs';
import { hindsightComponents } from './hindsight.mjs';
import { makeObsContext, evalAll, randomProgram, mutateProgram, observableId, candidateFitness, candidateLift, obsCorrelation, quantileEdges, describeProgram } from './observables.mjs';
import { makeValueModelV4Projection, takeIg, hindsightMae, labelMae, residualRows, activeObservables, labelsReady } from './valuemodel-v4.mjs';
import { makeCurriculumProjection, retroSpec, retroId, harderRetro, retroCriterion, labelsForDay, retroFitness, activeRetro } from './curriculum.mjs';
import { makeProgressProjection, diagnoseProgress, activeProgressInterventions } from './progress.mjs';

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
  // ---- v4 addons (off = v3 behaviour) ----
  hindsight: false,           // label the past with the future: hindsight.labeled rows for the value model (needs valueModel)
  hindsightHorizon: 7, hindsightFresh: 3, hindsightBatch: 120, hindsightBacklog: 3, hindsightTypes: null,
  discovery: false,           // evolve observables that explain the value model's residual (observable.* events)
  obsCandidates: 24, obsNewPerStep: 4, obsMinRows: 120, obsMinFitness: 0.01, obsMaxAdopted: 16, obsRedundancy: 0.9, obsRetireRows: 400, obsDepth: 2,
  obsLift: 0,                 // > 0: a second adoption route — a candidate whose top quintile carries ≥ obsLift × the mean label is adopted as a way of looking
  obsSteps: 1,                // discovery steps offered per heartbeat
  obsOps: false,              // adopted observables enter the strategy grammar as filter ops and rankers
  curriculum: false, retroMax: 3, retroCandidates: 4, retroTransfers: 2, retroMinValue: 0.3,
  metaAttention: true,        // learn actions (hindsight / discover / retro) compete in the attention model; false = fixed schedule
  reserveLearn: 0.15,
  learnCosts: { hindsight: 1.0, discover: 0.5, retro: 0.3 }, // nominal budget-seconds per learn action (declared, not learned from wall-clock: keeps runs reproducible)
  progress: false,            // false | 'observe' | true (raise discovery temperature on a frontier stall)
  progressWindow: 8, progressMinRuns: 10, progressCooldown: 6,
  vmDim: 256, vmMaxRows: 3000, vmRebuildEvery: 25, vmMinHindRows: 100,
  vmStack: true,              // a judgment-only head scores deliveries, with the hindsight model's prediction as a feature
});
const LEARN = new Set(['hindsight', 'discover', 'retro']);

const HELPERS = Object.freeze({ neighbors, degree, latestSignal, surprisal, burstScore, relationRecord, seriesLatest, seriesFirst, DAY_MS, cosine });

export async function runOnce(opts) {
  const {
    store, hub = null, ledgerDir = null, plugin, domain, node, role = 'worker',
    env = process.env, log = () => {}, wall = () => Date.now(), fetchImpl, sleep,
    policyConfig = {}, seed = null, outDir = null,
  } = opts;
  const cfg = { ...DEFAULTS, ...(opts.config ?? {}) };
  if (cfg.curriculum) cfg.hindsight = true;       // environments are labelled by hindsight
  if (cfg.hindsight || cfg.discovery) cfg.valueModel = true; // labels and observables are the value model's
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
  const v4 = { hindsight: !!cfg.hindsight, discovery: !!cfg.discovery, curriculum: !!cfg.curriculum, progress: !!cfg.progress, obsOps: !!cfg.obsOps };
  const useV4 = v4.hindsight || v4.discovery;
  const valueModelProjection = v3.value
    ? (useV4 ? makeValueModelV4Projection({ dim: cfg.vmDim, priorVar: cfg.vmPriorVar, noiseVar: cfg.vmNoiseVar, maxRows: cfg.vmMaxRows, rebuildEvery: cfg.vmRebuildEvery, stack: !!cfg.vmStack && !!cfg.hindsight, stackMinTrained: cfg.vmMinTrained }) : makeValueModelProjection({ priorVar: cfg.vmPriorVar, noiseVar: cfg.vmNoiseVar }))
    : null;
  const sentinelProjection = v3.sentinel ? makeSentinelProjection() : null;
  const curriculumProjection = v4.curriculum ? makeCurriculumProjection() : null;
  const progressProjection = v4.progress ? makeProgressProjection() : null;
  const [mem, arch, qd, plan, pol, vqP, frP, vmP, prP, seP, cuP, pgP] = await Promise.all([
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
    curriculumProjection ? project(store, curriculumProjection, { domain, log }) : null,
    progressProjection ? project(store, progressProjection, { domain, log }) : null,
  ]);
  const memory = mem.state, archive = arch.state, qdState = qd.state, planner = plan.state, policyState = pol.state;
  const vqState = vqP?.state ?? null, frontierState = frP?.state ?? null, vmState = vmP?.state ?? null, provenance = prP?.state ?? null, sentinelState = seP?.state ?? null;
  const cuState = cuP?.state ?? null, pgState = pgP?.state ?? null;
  const before = { entities: memory.entities.size, obs: memory.obsCount, elites: qdState.elitesReplaced, evaluations: qdState.evaluations, findings: archive.total, vqCells: vqState ? vqOccupied(vqState) : 0, adopted: vmState?.observables?.adopted.size ?? 0, solved: cuState?.solved ?? 0, transfers: cuState?.transfers ?? 0 };

  // 3. policy + ledger ---------------------------------------------------------
  let ledger = null;
  const projections = [[memoryProjection, memory, domain], [archiveProjection, archive, domain], [qdProjection, qdState, domain], [plannerProjection, planner, domain], [policyProjection, policyState, undefined]];
  if (vqProjection) projections.push([vqProjection, vqState, domain]);
  if (frontierProjection) projections.push([frontierProjection, frontierState, domain]);
  if (valueModelProjection) projections.push([valueModelProjection, vmState, domain]);
  if (provenance) projections.push([provenanceProjection, provenance, domain]);
  if (sentinelProjection) projections.push([sentinelProjection, sentinelState, domain]);
  if (curriculumProjection) projections.push([curriculumProjection, cuState, domain]);
  if (progressProjection) projections.push([progressProjection, pgState, domain]);
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

  // 3d. v4: learning progress — diagnose a frontier stall; raise discovery temperature if asked to act
  let progressInfo = null, discoveryTemperature = 1;
  if (pgState) {
    const diag = diagnoseProgress(pgState, { window: cfg.progressWindow, minRuns: cfg.progressMinRuns });
    const active = activeProgressInterventions(pgState);
    if (active.length) discoveryTemperature = 2;
    let intervened = null;
    const lastAt = pgState.interventions.at(-1)?.index ?? -Infinity;
    if (diag.stalled && cfg.progress === true && !active.length && pgState.index - lastAt >= cfg.progressCooldown) { intervened = 'temperature'; discoveryTemperature = 2; }
    progressInfo = { ...diag, intervened, ttl: 4, active: active.length };
  }

  // 3e. v4: retrospective environments — minimal criterion, spawn from labelled days, harder children
  const today = Math.floor(now / DAY_MS);
  const runsPast = useV4 ? await pastRuns(store, domain) : [];
  let solvedThisRun = 0;
  if (cuState && vmState) {
    for (const ch of activeRetro(cuState)) {
      const verdict = retroCriterion(ch);
      if (verdict === 'active') continue;
      await ledger.emit('challenge.retired', { challengeId: ch.id, reason: verdict, runId, ts: now });
      if (verdict !== 'solved') continue;
      solvedThisRun++;
      const spec = harderRetro(ch.spec);
      const id = retroId(spec);
      if (spec.minValue > ch.spec.minValue && !cuState.challenges.has(id) && activeRetro(cuState).length < cfg.retroMax) await ledger.emit('challenge.created', { challengeId: id, spec, parent: ch.id, origin: 'solved', runId, ts: now });
    }
    const haveDays = new Set([...cuState.challenges.values()].map((c) => c.spec.retro?.asOfDay));
    for (const d of [...vmState.labelledDays].filter((x) => !haveDays.has(x)).sort((a, b) => b - a)) {
      if (activeRetro(cuState).length >= cfg.retroMax) break;
      const run = runsPast.filter((r) => r.day === d).at(-1);
      if (!run || !labelsForDay(vmState, d).size) continue;
      const spec = retroSpec({ asOfDay: d, cutoffTs: run.ts, now: run.now, minValue: cfg.retroMinValue });
      const id = retroId(spec);
      if (cuState.challenges.has(id)) continue;
      await ledger.emit('challenge.created', { challengeId: id, spec, parent: null, origin: 'schedule', runId, ts: now });
    }
  }

  // 4. value function + vectors ----------------------------------------------
  let vectors = new MemoryVectors(memory, embedder);
  let degreeRanks = new DegreeRanks(memory);
  let signalRanks = v3.phenotype || v3.value ? new SignalRanks(memory, plugin.schema.signals) : null;
  const valueCache = new Map();
  const featureCache = new Map();
  // v4: adopted observables — a live evaluation context, outputs per entity (adopted + candidates), and the grown grammar
  let obsCtx = null;
  const obsCache = new Map();
  const adoptedList = vmState?.observables ? [...vmState.observables.adopted.values()] : [];
  const searchSchema = v4.obsOps && adoptedList.length ? { ...plugin.schema, observables: adoptedList.map((o) => ({ id: o.id, type: o.type })) } : plugin.schema;
  const liveObs = () => { if (!obsCtx) obsCtx = makeObsContext({ memory, now, schema: plugin.schema, degreeRanks, signalRanks }); return obsCtx; };
  function obsOf(id) {
    if (!vmState?.observables) return null;
    if (obsCache.has(id)) return obsCache.get(id);
    const programs = activeObservables(vmState);
    const o = programs.length ? evalAll(liveObs(), programs, id) : null;
    obsCache.set(id, o);
    return o;
  }
  const obsEval = (oid, eid) => { const o = vmState?.observables?.adopted.get(oid); return o ? liveObs().eval(o.program, eid) : null; };
  const obsName = (oid) => { const o = vmState?.observables?.adopted.get(oid); return o ? describeProgram(o.program) : oid; };
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
  const learnedReady = () => !!(vmState && (vmState.trained >= cfg.vmMinTrained || (vmState.observables && labelsReady(vmState) && vmState.hindRows >= cfg.vmMinHindRows)));
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
      const f = featuresOf(id), raw = rawValue(id), o = obsOf(id);
      return j ? posteriorValue(vmState, f, raw, Math.max(0, Math.min(1, Number(j.value))), { judgmentSd: cfg.judgmentSd, obs: o }).value : predictValue(vmState, f, raw, o).value;
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
    obsCtx = null;
    obsCache.clear();
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
  // v4: learn actions — a hindsight pass per pending day, one discovery step, retrospective evaluations and transfers.
  // They are candidates like any other: their outcome is measured learning progress (information gained by the value
  // model, fitness of adopted observables, retrospective fitness), so the same objective decides how much to invest.
  const learn = [];
  let pendingDays = [];
  if (vmState?.observables && v4.hindsight) {
    const byDay = new Map();
    for (const r of runsPast) if (r.day <= today - cfg.hindsightHorizon && !vmState.labelledDays.has(r.day)) byDay.set(r.day, r);
    pendingDays = [...byDay.values()].sort((a, b) => b.day - a.day);
    for (const r of pendingDays.slice(0, cfg.hindsightBacklog)) learn.push({ id: `hindsight:${r.day}`, type: 'hindsight', run: r, features: { type: 'hindsight', lag: bucket(today - r.day - cfg.hindsightHorizon, [1, 3, 8]), rows: bucket(vmState.hindRows, [100, 500, 2000]), pairs: bucket(vmState.labelPairs, [5, 20, 80]) }, cost: cfg.learnCosts.hindsight });
  }
  if (vmState?.observables && v4.discovery) for (let i = 0; i < cfg.obsSteps; i++) learn.push({ id: `discover:${i}`, type: 'discover', features: { type: 'discover', adopted: bucket(vmState.observables.adopted.size, [1, 4, 8, 16]), cands: bucket(vmState.observables.candidates.size, [4, 12, 24]), rows: bucket(vmState.rows.length, [120, 400, 1200, 2500]), temp: discoveryTemperature > 1 }, cost: cfg.learnCosts.discover });
  if (cuState && vmState) {
    const rr = rng.fork('retro-cands');
    let n = 0;
    for (const env of rr.shuffle(activeRetro(cuState))) {
      for (let i = 0; i < 2 && n < cfg.retroCandidates; i++, n++) {
        const mode = env.elites.length && rr() < 0.5 ? 'mutation' : cells.length && rr() < 0.6 ? 'transfer-in' : 'random';
        learn.push({ id: `retro:${env.id}:${i}`, type: 'retro', env, mode, features: { type: 'retro', minValue: bucket(env.spec.minValue, [0.3, 0.5, 0.7]), evals: bucket(env.evaluations, [3, 10, 30]), best: bucket(env.best, [0.02, 0.1, 0.2]), mode }, cost: cfg.learnCosts.retro });
      }
    }
    let t = 0;
    for (const env of [...cuState.challenges.values()].sort((a, b) => b.best - a.best)) {
      for (const e of env.elites.slice(0, 2)) {
        if (t >= cfg.retroTransfers) break;
        const g = qdState.genomes.get(e.genomeId);
        if (g && g.evals > 0 && (now - g.lastTs) / DAY_MS < 7) continue;
        candidates.push({ id: `transfer:${env.id}:${e.genomeId}`, type: 'transfer', genome: e.genome, challenge: env, elite: e, features: { type: 'transfer', fit: bucket(e.fitness, [0.05, 0.15, 0.3]), minValue: bucket(env.spec.minValue, [0.3, 0.5, 0.7]), retro: true }, cost: evolveCost });
        t++;
      }
    }
  }
  const forcedLearn = [];
  if (cfg.metaAttention) candidates.push(...learn); else forcedLearn.push(...learn);
  const forced = [];
  if (qdState.evaluations === 0) for (const [i, g] of canonicalGenomes(plugin.schema).entries()) forced.push({ id: `canonical:${i}`, type: 'seeded', genome: g, kind: 'canonical', features: { type: 'seeded', canonical: true }, cost: evolveCost });
  for (const s of archive.seeded) if (!qdState.genomes.has(genomeId(normalizeGenome(s.genome)))) forced.push({ id: `seeded:${s.id}`, type: 'seeded', genome: normalizeGenome(s.genome), kind: 'seeded', features: { type: 'seeded', canonical: false }, cost: evolveCost });

  // 6. attention: select under budget --------------------------------------------
  const reserve = [{ match: (c) => c.type === 'poll', fraction: cfg.reserveSense }, { match: (c) => c.type !== 'poll' && !LEARN.has(c.type), fraction: cfg.reserveThink }];
  if (learn.length && cfg.metaAttention) reserve.push({ match: (c) => LEARN.has(c.type), fraction: cfg.reserveLearn }); // labels are a complement, not a substitute (D7)
  const selection = selectActions(candidates, { model: planner.model, rng: rng.fork('select'), beta: cfg.beta, budget: cfg.budgetSeconds, reserve });
  // Sense before you think; learn (label the past, adopt observables) before you evaluate, so deliveries use the newest model.
  const learnOrder = { hindsight: 0, discover: 1, retro: 2 };
  const chosenLearn = [...forcedLearn, ...selection.chosen.filter((c) => LEARN.has(c.type))].sort((a, b) => learnOrder[a.type] - learnOrder[b.type] || (a.type === 'hindsight' ? a.run.day - b.run.day : 0));
  const chosen = [...selection.chosen.filter((c) => c.type === 'poll'), ...forced, ...chosenLearn, ...selection.chosen.filter((c) => c.type !== 'poll' && !LEARN.has(c.type))];
  await ledger.emit('action.planned', {
    runId, candidates: candidates.length, chosen: chosen.length, budgetSeconds: cfg.budgetSeconds, estimatedSeconds: selection.used,
    top: selection.chosen.slice(0, 25).map((c) => ({ id: c.id, score: round(c.score), exploit: round(c.exploit), ig: round(c.ig), cost: round(c.cost) })),
  });

  // 7. act ------------------------------------------------------------------------
  const pool = new Map();
  let obsEvents = null;                 // v4: the observation log, read once per heartbeat for time-travel folds
  const memAtCache = new Map();         // v4: memory as of a cutoff, per heartbeat
  const derivedAt = (memAt, t) => ({ vectors: new MemoryVectors(memAt, embedder), degreeRanks: new DegreeRanks(memAt), signalRanks: new SignalRanks(memAt, plugin.schema.signals), now: t });
  const counters = { byType: {}, executed: 0, newObservations: 0, observations: 0, evaluations: 0, denials: 0, blocked: 0, igSum: 0, exploitSum: 0, hindRows: 0, hindIg: 0, adopted: 0, newShapes: 0, proposed: 0, retroEvals: 0 };
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
        } else if (action.type === 'hindsight') {
          refreshDerived();
          const r = await executeHindsight(action);
          raw = r.raw; extra = r.extra;
        } else if (action.type === 'discover') {
          refreshDerived();
          const r = await executeDiscover(action);
          raw = r.raw; extra = r.extra;
        } else if (action.type === 'retro') {
          refreshDerived();
          const r = await executeRetro(action);
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
    const schema = searchSchema;
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
    const ctx = { memory, vectors, now, value: valueOf, k: cfg.k, isNovel: (id) => noveltyOf(archive, { entityId: id, now, windowDays: cfg.windowDays }).hard === 1, obs: v4.obsOps ? obsEval : undefined, obsName };
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
    const ch = action.challenge, schema = searchSchema;
    const r = rng.fork(`challenge:${action.id}:${counters.executed}`);
    let genome, parent = null;
    if (action.mode === 'mutation' && ch.elites.length) { const e = r.pick(ch.elites); genome = mutateStrong(e.genome, schema, r, cfg.mutationStrength); parent = { genomeId: e.genomeId, cell: ch.id }; }
    else if (action.mode === 'transfer-in' && cells.length) { const c = r.pick(cells.slice(0, 20)); genome = c.genome; parent = { genomeId: c.genomeId, cell: c.cell }; }
    else genome = randomGenome(schema, r);
    const accept = regionAccept(ch.spec, memory, now);
    const ctx = { memory, vectors, now, value: valueOf, k: cfg.k, isNovel: (id) => noveltyOf(archive, { entityId: id, now, windowDays: cfg.windowDays }).hard === 1, accept, obs: v4.obsOps ? obsEval : undefined, obsName };
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

  // 7b. v4 executors ----------------------------------------------------------------
  async function memoryAt(cutoffTs) {
    if (memAtCache.has(cutoffTs)) return memAtCache.get(cutoffTs);
    if (!obsEvents) obsEvents = await store.readAll({ domain, kinds: ['observation.seen', 'entity.embedded'] });
    const m = await memoryAsOf(store, { domain, cutoffTs, events: obsEvents });
    memAtCache.set(cutoffTs, m);
    return m;
  }

  /** Label the entities that were fresh at a past heartbeat with what memory knows now (core/hindsight.mjs). */
  async function executeHindsight(action) {
    const r = action.run, H = cfg.hindsightHorizon;
    const memAt = await memoryAt(r.ts);
    const d = derivedAt(memAt, r.now);
    const ctxAt = makeObsContext({ memory: memAt, now: r.now, schema: plugin.schema, degreeRanks: d.degreeRanks, signalRanks: d.signalRanks });
    const programs = activeObservables(vmState);
    const rawAt = (id) => { const e = memAt.entities.get(id); if (!e) return 0; const v = Number(plugin.value.score(e, { memory: memAt, now: r.now, vectors: d.vectors, helpers: HELPERS, domain })); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; };
    const types = cfg.hindsightTypes ?? [plugin.schema.primaryType ?? plugin.schema.entityTypes[0]];
    const fresh = [];
    const t0 = r.now - cfg.hindsightFresh * DAY_MS;
    for (const t of types) for (const id of memAt.byType.get(t) ?? []) { const at = memAt.ingestedAt.get(id); if (at !== undefined && at >= t0 && at <= r.ts) fresh.push(id); }
    fresh.sort();
    const pick = new Set(rng.fork(`hindsight:${r.day}`).shuffle(fresh).slice(0, cfg.hindsightBatch));
    for (const [id, j] of archive.judgments) if (memAt.entities.has(id) && Math.abs(j.ts - r.now) <= 2 * DAY_MS) pick.add(id);
    takeIg(vmState);
    let rows = 0;
    for (const id of [...pick].sort()) {
      const comps = hindsightComponents(id, { memory, asOf: r.now, horizon: H, schema: plugin.schema });
      if (!comps) continue;
      const ps = rawAt(id);
      const features = entityFeatures(id, { memory: memAt, schema: plugin.schema, now: r.now, degreeRanks: d.degreeRanks, signalRanks: d.signalRanks, pluginScore: ps, tokens: cfg.vmTokens });
      const obs = programs.length ? evalAll(ctxAt, programs, id) : null;
      const prev = archive.byEntity.get(id);
      const ev = await ledger.emit('hindsight.labeled', { runId, entityId: id, asOf: r.now, asOfDay: r.day, horizonDays: H, components: comps, features, obs, pluginScore: round(ps, 4), novelAt: prev && prev.last < r.now ? 0 : 1, rev: vmState.observables.rev, ts: now }, { dedupKey: `hind:${domain}:${id}:${r.day}:${H}`, skipIfDedupKeyExists: true });
      if (ev) rows++;
    }
    if (!vmState.labelledDays.has(r.day)) await ledger.emit('hindsight.labeled', { runId, asOfDay: r.day, horizonDays: H, empty: true, ts: now });
    const ig = takeIg(vmState);
    counters.hindRows += rows; counters.hindIg += ig;
    return { raw: ig, extra: { asOfDay: r.day, rows, batch: pick.size, ig: round(ig, 4), labelPairs: vmState.labelPairs, hindMae: round(hindsightMae(vmState) ?? 0, 4) } };
  }

  /** One generation of observable search: score candidates on the residual, adopt at most one, retire the hopeless, propose new ones. */
  async function executeDiscover() {
    const obsState = vmState.observables;
    const r = rng.fork(`discover:${counters.executed}`);
    const T = plugin.schema.primaryType ?? plugin.schema.entityTypes[0];
    const rows = vmState.rows.length >= cfg.obsMinRows ? residualRows(vmState) : [];
    const results = [];
    for (const c of obsState.candidates.values()) results.push({ c, ...(rows.length ? candidateFitness(c.id, rows, { minRows: cfg.obsMinRows }) : { fitness: null, n: 0, batches: 0 }), lift: rows.length && cfg.obsLift > 0 ? candidateLift(c.id, rows, { minRows: cfg.obsMinRows }).lift : null });
    const ranked = results.filter((x) => x.fitness !== null).sort((a, b) => b.fitness - a.fitness);
    let gain = 0, adoptedNow = 0, newShapes = 0;
    const adopt = async (x, role, score) => {
      const twin = [...obsState.adopted.keys()].find((aid) => Math.abs(obsCorrelation(x.c.id, aid, rows)) > cfg.obsRedundancy);
      if (twin) { await ledger.emit('observable.retired', { runId, id: x.c.id, reason: 'redundant', twin, fitness: round(x.fitness ?? 0, 5), n: x.n, ts: now }); return false; }
      const edges = quantileEdges(rows.map((row) => row.obs?.[x.c.id]).filter((v) => v !== undefined));
      if (!edges) return false;
      const isNew = !obsState.shapes.has(x.c.shape);
      await ledger.emit('observable.adopted', { runId, id: x.c.id, program: x.c.program, type: x.c.type, edges, fitness: round(x.fitness ?? 0, 5), lift: x.lift === null ? null : round(x.lift, 4), role, n: x.n, description: describeProgram(x.c.program), shape: x.c.shape, ts: now });
      gain += score; adoptedNow++; if (isNew) newShapes++;
      return true;
    };
    for (const x of ranked) {
      if (x.fitness < cfg.obsMinFitness || adoptedNow >= 1 || obsState.adopted.size >= cfg.obsMaxAdopted) break;
      if (await adopt(x, 'model', x.fitness)) break;
    }
    // the second route: a way of looking — its top quintile is rich in labelled value even if it explains no residual
    if (cfg.obsLift > 0 && obsState.adopted.size < cfg.obsMaxAdopted) {
      const byLift = results.filter((x) => x.lift !== null && x.lift >= cfg.obsLift && obsState.candidates.has(x.c.id)).sort((a, b) => b.lift - a.lift);
      for (const x of byLift) if (await adopt(x, 'search', Math.max(0, x.lift - 1) * 0.05)) break;
    }
    for (const x of results) if (x.fitness !== null && x.n >= cfg.obsRetireRows && x.fitness < cfg.obsMinFitness / 3 && obsState.candidates.has(x.c.id)) await ledger.emit('observable.retired', { runId, id: x.c.id, reason: 'unfit', fitness: round(x.fitness, 5), n: x.n, ts: now });
    const parents = [...obsState.adopted.values(), ...ranked.slice(0, 3).map((x) => x.c)];
    let proposed = 0;
    const want = Math.min(cfg.obsCandidates - obsState.candidates.size, Math.round(cfg.obsNewPerStep * discoveryTemperature));
    for (let i = 0; i < want; i++) {
      let program, parent = null;
      if (parents.length && r() < 0.5) { const p = r.pick(parents); program = mutateProgram(p.program, plugin.schema, T, r); parent = p.id; }
      else program = randomProgram(plugin.schema, T, r, cfg.obsDepth + (discoveryTemperature > 1 ? 1 : 0));
      const id = observableId(program);
      if (obsState.adopted.has(id) || obsState.candidates.has(id)) continue;
      await ledger.emit('observable.proposed', { runId, id, program, type: T, parent, origin: discoveryTemperature > 1 ? 'stall' : 'search', description: describeProgram(program), ts: now });
      proposed++;
    }
    counters.adopted += adoptedNow; counters.newShapes += newShapes; counters.proposed += proposed;
    return { raw: gain, extra: { adopted: adoptedNow, proposed, evaluated: ranked.length, best: ranked[0] ? round(ranked[0].fitness, 4) : null, rows: rows.length, candidates: obsState.candidates.size } };
  }

  /** Evaluate a solver in a retrospective environment: memory as it was, hindsight labels as truth (core/curriculum.mjs). */
  async function executeRetro(action) {
    const env = action.env, spec = env.spec;
    const memAt = await memoryAt(spec.retro.cutoffTs);
    const d = derivedAt(memAt, spec.retro.now);
    const labels = labelsForDay(vmState, spec.retro.asOfDay);
    const r = rng.fork(`retro:${action.id}:${counters.executed}`);
    let genome, parent = null;
    if (action.mode === 'mutation' && env.elites.length) { const e = r.pick(env.elites); genome = mutateStrong(e.genome, searchSchema, r, cfg.mutationStrength); parent = { genomeId: e.genomeId, cell: env.id }; }
    else if (action.mode === 'transfer-in' && cells.length) { const c = r.pick(cells.slice(0, 20)); genome = c.genome; parent = { genomeId: c.genomeId, cell: c.cell }; }
    else genome = randomGenome(searchSchema, r);
    const ctxAt = makeObsContext({ memory: memAt, now: spec.retro.now, schema: plugin.schema, degreeRanks: d.degreeRanks, signalRanks: d.signalRanks });
    const ctx = { memory: memAt, vectors: d.vectors, now: spec.retro.now, value: (id) => labels.get(id)?.value ?? 0, k: cfg.k, isNovel: (id) => labels.get(id)?.novel === 1, obs: v4.obsOps ? (oid, eid) => { const o = vmState.observables.adopted.get(oid); return o ? ctxAt.eval(o.program, eid) : null; } : undefined, obsName };
    const out = runStrategy(genome, ctx);
    const findings = out.items.map((it) => { const v = labels.get(it.id)?.value ?? 0; return { entityId: it.id, value: v, novelty: 1, hard: 1, score: v }; });
    const fitness = retroFitness(findings, cfg.k, genome, spec);
    const gid = genomeId(normalizeGenome(genome));
    counters.retroEvals++;
    await ledger.emit('challenge.evaluated', { challengeId: env.id, runId, genomeId: gid, genome, fitness: round(fitness, 5), kind: action.mode, parent, nOut: findings.length, ts: now });
    return { raw: Math.max(0, fitness), extra: { genomeId: gid, kind: `retro:${action.mode}`, fitness: round(fitness, 5), env: env.id, asOfDay: spec.retro.asOfDay, nOut: findings.length } };
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
    const cands = [...pool.values()].sort((a, b) => b.score - a.score).slice(0, Math.max(cfg.maxFindings * 4, 60)).map((f) => ({ entityId: f.entityId, features: featuresOf(f.entityId), obs: obsOf(f.entityId), pluginScore: rawValue(f.entityId), score: f.score, findingId: findings.find((x) => x.entityId === f.entityId)?.findingId ?? null }));
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
    for (const c of need.values()) await ledger.emit('value.features', { runId, entityId: c.entityId, features: c.features, ...(c.obs ? { obs: c.obs, rev: vmState.observables?.rev ?? 0 } : {}), pluginScore: round(c.pluginScore, 4), ts: now });
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
  if (useV4 || cuState || pgState) {
    const v = {};
    if (vmState?.observables) {
      const usesObs = (g) => (g.pipe ?? []).some((op) => op.op === OBS_OP) || g.rank?.by === 'obs' || g.seed?.op === OBS_SEED;
      v.hindsight = { rows: vmState.hindRows, rowsThisRun: counters.hindRows, mae: round(hindsightMae(vmState) ?? 0, 4), labelPairs: vmState.labelPairs, labelsReady: labelsReady(vmState), labelMae: round(labelMae(vmState) ?? 0, 4), labelledDays: vmState.labelledDays.size, pending: pendingDays.length, ig: round(counters.hindIg, 4), rebuilds: vmState.rebuilds, ready: learnedReady(), stacked: !!(vmState.stack && vmState.trainedJ >= vmState.stackMinTrained) };
      v.observables = { adopted: vmState.observables.adopted.size, candidates: vmState.observables.candidates.size, rev: vmState.observables.rev, retired: vmState.observables.retired, adoptedThisRun: counters.adopted, newShapesThisRun: counters.newShapes, proposedThisRun: counters.proposed, shapes: vmState.observables.shapes.size, inGrammar: searchSchema.observables?.length ?? 0, elitesUsingObs: [...qdState.cells.values()].filter((c) => usesObs(c.genome)).length, names: [...vmState.observables.adopted.values()].map((o) => `${describeProgram(o.program)} (${round(o.fitness ?? 0, 3)})`).slice(0, 16) };
    }
    if (cuState) v.curriculum = { active: activeRetro(cuState).length, total: cuState.challenges.size, solved: cuState.solved, retired: cuState.retired, evaluations: cuState.evaluations, transfers: cuState.transfers, solvedThisRun, retroEvalsThisRun: counters.retroEvals, transferElites: [...qdState.cells.values()].filter((c) => c.kind === 'transfer').length };
    if (progressInfo) v.progress = progressInfo;
    summary.v4 = v;
  }
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

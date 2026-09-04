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
import { runStrategy, describeBehavior, cellOf, DegreeRanks, randomGenome, mutate, crossover, genomeId, normalizeGenome, canonicalGenomes } from './strategy.mjs';
import { HashEmbedder, cosine } from './embed.mjs';
import { Policy, PolicyError } from '../policy/policy.mjs';
import { pull, push, exportLedger, importLedger } from './sync.mjs';

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
  const plannerProjection = makePlannerProjection({ priorVar: cfg.priorVar, noiseVar: cfg.noiseVar, forgetting: cfg.forgetting });
  const [mem, arch, qd, plan, pol] = await Promise.all([
    project(store, memoryProjection, { domain, log }),
    project(store, archiveProjection, { domain, log }),
    project(store, qdProjection, { domain, log }),
    project(store, plannerProjection, { domain, log }),
    project(store, policyProjection, { domain: undefined, log }),
  ]);
  const memory = mem.state, archive = arch.state, qdState = qd.state, planner = plan.state, policyState = pol.state;
  const before = { entities: memory.entities.size, obs: memory.obsCount, elites: qdState.elitesReplaced, evaluations: qdState.evaluations, findings: archive.total };

  // 3. policy + ledger ---------------------------------------------------------
  let ledger = null;
  const projections = [[memoryProjection, memory, domain], [archiveProjection, archive, domain], [qdProjection, qdState, domain], [plannerProjection, planner, domain], [policyProjection, policyState, undefined]];
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

  // 4. value function + vectors ----------------------------------------------
  let vectors = new MemoryVectors(memory, embedder);
  let degreeRanks = new DegreeRanks(memory);
  const valueCache = new Map();
  const calibration = fitCalibration(archive, (id) => rawValue(id));
  function rawValue(id) {
    const e = memory.entities.get(id);
    if (!e) return 0;
    let v = Number(plugin.value.score(e, { memory, now, vectors, helpers: HELPERS, domain }));
    if (!Number.isFinite(v)) v = 0;
    return Math.max(0, Math.min(1, v));
  }
  function valueOf(id) {
    if (valueCache.has(id)) return valueCache.get(id);
    const j = archive.judgments.get(id);
    let v;
    if (j) v = Math.max(0, Math.min(1, Number(j.value)));
    else { v = rawValue(id); if (calibration) v = Math.max(0, Math.min(1, calibration.a + calibration.b * v)); }
    valueCache.set(id, v);
    return v;
  }
  function refreshDerived() {
    if (!memoryDirty) return;
    vectors = new MemoryVectors(memory, embedder);
    degreeRanks = new DegreeRanks(memory);
    valueCache.clear();
    memoryDirty = false;
  }
  const recentVecs = archive.recent.slice(-200).map((f) => (f.title ? vectors.embedText(f.title) : null)).filter(Boolean);

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
  const cells = [...qdState.cells.entries()].map(([cell, e]) => ({ cell, ...e, curiosity: qdState.curiosity.get(cell) ?? 0 })).sort((a, b) => b.curiosity - a.curiosity || b.fitness - a.fitness);
  for (const c of cells.slice(0, cfg.maxEvolveCandidates)) {
    candidates.push({ id: `evolve:${c.cell}`, type: 'evolve', parentCell: c.cell, parent: c, features: { type: 'evolve', cell: c.cell, cur: bucket(c.curiosity, [0.5, 1.5, 3]), fit: bucket(c.fitness, [0.05, 0.15, 0.3]), age: bucket((now - c.ts) / DAY_MS, [1, 3, 10]), size: bucket(1 + (c.genome.pipe?.length ?? 0), [2, 3, 4]) }, cost: evolveCost });
  }
  if (cells.length >= 2) {
    const xr = rng.fork('xover');
    for (let i = 0; i < cfg.maxCrossovers; i++) {
      const a = xr.pick(cells), b = xr.pick(cells);
      if (a.cell === b.cell) continue;
      const dist = Math.abs(a.bd.age - b.bd.age) + Math.abs(a.bd.centrality - b.bd.centrality) + Math.abs(a.bd.spread - b.bd.spread);
      candidates.push({ id: `xover:${a.cell}:${b.cell}`, type: 'crossover', parentA: a, parentB: b, features: { type: 'crossover', fitA: bucket(a.fitness, [0.05, 0.15, 0.3]), fitB: bucket(b.fitness, [0.05, 0.15, 0.3]), dist: bucket(dist, [0.3, 0.8, 1.5]) }, cost: evolveCost });
    }
  }
  const nRandom = cells.length ? cfg.randomGenomes : Math.max(cfg.randomGenomes, 6);
  for (let i = 0; i < nRandom; i++) candidates.push({ id: `random:${i}`, type: 'random', features: { type: 'random', archive: bucket(cells.length, [1, 10, 50]) }, cost: evolveCost });
  const stale = cells.filter((c) => (now - c.ts) / DAY_MS >= cfg.reevaluateAfterDays).sort((a, b) => a.ts - b.ts).slice(0, cfg.maxReevaluate);
  for (const c of stale) candidates.push({ id: `reeval:${c.cell}`, type: 'reevaluate', parent: c, parentCell: c.cell, features: { type: 'reevaluate', stale: bucket((now - c.ts) / DAY_MS, [1, 3, 10]), fit: bucket(c.fitness, [0.05, 0.15, 0.3]) }, cost: evolveCost });
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
    let genome, kind, parent = null;
    if (action.type === 'evolve') { genome = mutate(action.parent.genome, schema, r); kind = 'mutation'; parent = { genomeId: action.parent.genomeId, cell: action.parentCell }; }
    else if (action.type === 'crossover') { genome = crossover(action.parentA.genome, action.parentB.genome, r); kind = 'crossover'; parent = { genomeId: action.parentA.genomeId, cell: action.parentA.cell }; }
    else if (action.type === 'reevaluate') { genome = action.parent.genome; kind = 'reevaluate'; parent = null; }
    else if (action.type === 'seeded') { genome = action.genome; kind = action.kind ?? 'seeded'; }
    else { genome = randomGenome(schema, r); kind = 'random'; }
    const result = evaluateGenome(genome, kind, parent);
    counters.evaluations++;
    await ledger.emit('strategy.evaluated', { runId, genomeId: result.genomeId, genome, fitness: round(result.fitness, 5), bd: result.bd, cell: result.cell, bins: cfg.bins, parent, kind, nOut: result.findings.length, ts: now, top: result.findings.slice(0, 3).map((f) => ({ entityId: f.entityId, score: round(f.score) })) });
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
    return { genomeId: genomeId(normalizeGenome(genome)), fitness, bd, cell: cellOf(bd, cfg.bins), findings, kind, parent };
  }

  // 8. select outputs: novel, valuable, diverse ------------------------------------
  refreshDerived();
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
  await ledger.emit('run.completed', summary);

  // 10. snapshots + sync out ------------------------------------------------------------
  const maxIngest = await store.maxIngestSeq();
  const watermark = ledger.clock.wall ? `${ledger.clock.wall.toString(16).padStart(12, '0')}-${ledger.clock.logical.toString(16).padStart(4, '0')}-${node}` : '';
  for (const [p, s, d] of projections) await store.putSnapshot({ name: `${p.name}:${d ?? '*'}`, version: p.version, watermark, ingestSeq: maxIngest, state: p.dehydrate(s), builtAt: Date.now() });
  if (hub) await push(store, hub, { log });
  if (ledgerDir) await exportLedger(store, ledgerDir);
  return { summary, findings, denials: policy.network.denials, blocks: policy.network.summary().blocks };
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

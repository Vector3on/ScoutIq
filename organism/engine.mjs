import fs from 'node:fs';
import path from 'node:path';
import { LocalStore } from '../substrate/core/store.mjs';
import { Ledger } from '../substrate/core/ledger.mjs';
import { shortHash } from '../substrate/core/events.mjs';
import { LinearModel, featurize } from '../substrate/core/attention.mjs';
import { qdProjection } from '../substrate/core/qd.mjs';
import { memoryProjection } from '../substrate/core/memory.mjs';
import { foldEvents } from '../substrate/core/projections.mjs';
import { evaluateTarget } from '../scripts/ev-core.mjs';
import { buildSpine } from '../substrate/plugins/bounty/spine.mjs';
import { observerPolicy } from './policy.mjs';
import { loadSnapshot, indexSnapshot } from './snapshot.mjs';
import { candidateSeams, lens, mutate, questions, observe, entropy, descriptor, HYPOTHESES, OBSERVER_VERSION } from './lenses.mjs';
import { partition } from './frozen.mjs';

const DOMAIN = 'synthesis-organism';
const rows = HYPOTHESES.map(h => [h.local, h.neighbor]);
const column = q => q.field === 'local' ? '0' : '1';

export function attentionScore({ ig, modelIg, predictedGain, ev, cost }) {
  // EV only modulates. A large reward cannot turn a zero-information read useful.
  return (ig + 0.2 * modelIg + 0.2 * Math.max(0, predictedGain)) *
    (1 + 0.1 * Math.log1p(Math.max(0, ev)) / Math.log(50_001)) / Math.max(1, cost);
}

export async function run({ manifestPath, db = ':memory:', budget = 16, allowGrowth = true, reuseArchive = true, now = () => Date.now() }) {
  if (!Number.isInteger(budget) || budget < 0 || budget > 128) throw new Error('Budget must be 0..128 file observations');
  const snapshot = loadSnapshot(manifestPath), index = indexSnapshot(snapshot), spine = buildSpine();
  const catalogId = shortHash([spine.anatomy, spine.techniques]);
  let lock = null, store;
  if (db !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(db)), { recursive: true });
    lock = fs.openSync(`${db}.lock`, 'wx');
  }
  try {
    store = new LocalStore(db);
    const previous = await store.readAll({ domain: DOMAIN });
    const qd = foldEvents(qdProjection, previous).state;
    const cache = new Map(previous.filter(e => e.kind === 'observation.seen' && e.body.observationKey)
      .map(e => [e.body.observationKey, e.body.result]));
    const completed = new Map(previous.filter(e => e.kind === 'note.recorded' && e.body.type === 'conclusion')
      .map(e => [e.body.key, e.body]));
    const model = new LinearModel({ dim: 32 });
    for (const e of previous) if (e.kind === 'action.outcome' && e.body.features) model.update(featurize(e.body.features, 32), e.body.gain);
    let ledger;
    const policy = observerPolicy((kind, body) => ledger.emit(kind, body));
    ledger = await new Ledger({ store, node: 'organism', policy, domain: DOMAIN, now }).init();
    for (const e of previous.slice(-1)) ledger.observeClock(e.hlc);
    const emit = (kind, body, dedupKey) => ledger.emit(kind, body, { dedupKey, skipIfDedupKeyExists: !!dedupKey });
    const stats = { fileObservations: 0, queries: 0, cachedQueries: 0, grownLenses: 0, transferredLenses: 0,
      reusedConclusions: 0, newConclusions: 0, bitsReduced: 0, freshObservationBits: 0, networkRequests: 0 };
    await emit('run.started', { snapshot: snapshot.identity, budget, observer: OBSERVER_VERSION });
    const tasks = [];
    for (const target of snapshot.manifest.targets) {
      const ev = evaluateTarget(target.program, target.asset, { now: new Date(now()).toISOString() });
      for (const seam of candidateSeams(target, index, spine)) {
        if (!seam.untriedCells.length) continue;
        const base = lens(seam.family);
        const elite = reuseArchive ? [...qd.cells.values()].filter(c => c.genome.seed?.family === seam.family && c.genome.pipe?.length)
          .sort((a, b) => b.fitness - a.fitness)[0] : null;
        const way = elite ? lens(seam.family, 1) : base;
        // Invalidate on a changed dependency closure, observer OR atlas/catalog.
        const dependencyKeys = questions(target, snapshot, index, lens(seam.family, 1)).map(q => q.key);
        const key = shortHash([target, dependencyKeys, catalogId, OBSERVER_VERSION]);
        const old = completed.get(key);
        if (old) stats.reusedConclusions++;
        else if (elite) stats.transferredLenses++;
        tasks.push({ target, seam, ev, key, way, observed: {}, trace: [], result: old ?? null, stopped: !!old, transfer: !!elite });
      }
    }
    // Each turn consumes a query, grows a bounded lens, or terminates a task.
    // Fresh observations have an explicit file-read budget; cached evidence is free.
    for (let turn = 0; turn < tasks.length * 5 + 1; turn++) {
      const options = [];
      for (const task of tasks.filter(t => !t.stopped)) {
        const state = partition(rows, task.observed);
        const qs = questions(task.target, snapshot, index, task.way).filter(q => !(column(q) in task.observed));
        const informative = qs.filter(q => entropy(state.partitions[Number(column(q))]) > 0);
        if (state.survivors.length <= 1 || !informative.length) {
          if (state.survivors.length > 1 && allowGrowth && task.way.radius === 0) {
            const child = mutate(task.way);
            const expanded = questions(task.target, snapshot, index, child).some(q => !(column(q) in task.observed));
            if (expanded) {
              await emit('observable.proposed', { parent: task.way.id, child: child.id, family: child.family,
                reason: 'Local observation vocabulary cannot distinguish remaining static hypotheses', survivors: state.survivors.length });
              task.way = child; stats.grownLenses++; continue;
            }
          }
          task.stopped = true;
          task.result = { type: 'conclusion', key: task.key, target: task.target.id, entry: task.target.entry,
            family: task.seam.family, lensId: task.way.id, radius: task.way.radius,
            status: state.survivors.length === 1 ? 'static-pattern-distinguished' : 'information-ceiling',
            hypotheses: state.survivors.map(i => HYPOTHESES[i].id), trace: task.trace,
            seamIds: task.seam.seamIds, techniqueReferences: task.seam.referenceIds,
            untriedReferenceCells: task.seam.untriedCells.length,
            untriedPreview: task.seam.untriedCells.slice(0, 5),
            referencePreview: task.seam.referenceIds.slice(0, 3).map(id => ({ id, sourceUrl: spine.techById.get(id).sourceUrl })),
            invariantPreview: task.seam.seamIds.slice(0, 3).flatMap(id => spine.seamIndex.get(id).invariants.map(inv => ({ seam: id, statement: inv.statement }))),
            catalogStatus: 'Inherited catalog; source URLs and coarse family assignments not independently revalidated',
            techniqueApplicability: 'unverified; no technique was executed or marked tried',
            evScore: task.ev.evScore, hardeningIndex: task.ev.hardeningIndex, purpose: task.target.purpose,
            runtimeSafety: 'unknown', limitation: 'Names and direct imports do not establish enforcement, runtime reachability, or a vulnerability.' };
          await emit('note.recorded', task.result, `conclusion:${task.key}`);
          await policy.actions.propose({ kind: 'human-source-review', target: task.target.id,
            rationale: 'Review the provenance and scope of this static observation before interpreting it.',
            payload: { conclusionKey: task.key, runtimeSafety: 'unknown', seamIds: task.seam.seamIds }, domain: DOMAIN });
          stats.newConclusions++; continue;
        }
        for (const q of informative) {
          const hit = cache.has(q.key), cost = hit ? 0 : q.cost;
          if (stats.fileObservations + cost > budget) continue;
          const features = [`family:${q.family}`, `kind:${q.kind}`, `files:${q.paths.length}`];
          const phi = featurize(features, 32), ig = entropy(state.partitions[Number(column(q))]);
          options.push({ task, q, hit, cost, features, phi, ig,
            score: attentionScore({ ig, modelIg: model.infoGain(phi), predictedGain: model.mean(phi), ev: task.ev.evScore, cost }) });
        }
      }
      options.sort((a, b) => b.score - a.score || a.task.key.localeCompare(b.task.key) || a.q.kind.localeCompare(b.q.kind));
      if (!options.length) {
        // A growth in this iteration may expose questions on the next one.
        if (tasks.some(t => !t.stopped && questions(t.target, snapshot, index, t.way)
          .some(q => !(column(q) in t.observed) && (cache.has(q.key) || stats.fileObservations + q.cost <= budget)))) continue;
        break;
      }
      const { task, q, hit, cost, features, phi, ig, score } = options[0];
      const before = partition(rows, task.observed).survivors.length;
      const observation = hit ? cache.get(q.key) : observe(q, snapshot);
      task.observed[column(q)] = observation.answer;
      const after = partition(rows, task.observed).survivors.length;
      const gain = Math.log2(before / after);
      task.trace.push({ kind: q.kind, answer: observation.answer, evidence: observation.evidence,
        searched: observation.searched, before, after, expectedBits: ig, realizedBits: gain, cached: hit });
      stats.queries++; stats.fileObservations += cost; stats.bitsReduced += gain;
      if (hit) stats.cachedQueries++;
      else {
        cache.set(q.key, observation); stats.freshObservationBits += gain;
        await emit('observation.seen', { observationKey: q.key, result: observation, observedAt: now(),
          entities: [{ type: 'anatomy-observation', key: q.key, attrs: { family: q.family, kind: q.kind },
            signals: { declarationPresent: observation.answer === 'yes' ? 1 : 0, files: q.paths.length, evidenceCount: observation.evidence.length, informationBits: gain } }] }, `observation:${q.key}`);
        model.update(phi, gain);
        await emit('action.outcome', { features, gain, question: q.key, cost, expectedBits: ig, score });
      }
      const d = descriptor(task.way, observation.evidence.length);
      const event = hit ? null : await emit('strategy.evaluated', { genomeId: task.way.id, genome: task.way.genome,
        ...d, fitness: gain / Math.max(1, q.cost) - 0.004 * (1 + task.way.radius), kind: 'static-lens',
        parent: task.way.radius ? { cell: descriptor(lens(q.family), 0).cell } : null,
        target: task.target.id, evidenceKey: q.key }, `evaluation:${task.key}:${q.key}`);
      if (event) qdProjection.apply(qd, event);
    }
    const records = tasks.map(t => t.result ?? { target: t.target.id, family: t.seam.family, status: 'budget-deferred', trace: t.trace, runtimeSafety: 'unknown' });
    await emit('run.completed', { snapshot: snapshot.identity, ...stats });
    const events = await store.readAll({ domain: DOMAIN });
    const memory = foldEvents(memoryProjection, events).state;
    return policy.sanitize({ format: 'organism-report-1', snapshot: snapshot.identity,
      boundary: 'offline observe-only; proposals only; target code never executed', stats,
      catalog: { techniques: spine.techniques.length, systemClasses: spine.anatomy.length, seams: spine.seamIndex.size, digest: catalogId },
      sources: snapshot.manifest.files.map(f => ({ path: f.path, revision: f.revision, sha256: f.sha256, repository: f.repository })),
      coverage: { capturedFiles: snapshot.files.size, bytes: snapshot.bytes, unresolvedRelativeImports: index.omittedImports,
        localCandidates: tasks.length, exhausted: tasks.every(t => t.stopped), grammarRadii: [0, 1] },
      archive: { cells: qd.cells.size, lenses: [...new Set([...qd.cells.values()].map(c => c.genomeId))].length,
        memoryEntities: memory.entities.size }, records }).value;
  } finally {
    if (store) await store.close();
    if (lock !== null) { fs.closeSync(lock); fs.unlinkSync(`${db}.lock`); }
  }
}

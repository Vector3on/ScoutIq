import path from 'node:path';
import fs from 'node:fs';
import { shortHash } from '../core/events.mjs';
import { acquire } from './acquire.mjs';
import { extract, workersFor, linkImports } from './extract.mjs';
import { infer, validateProposals } from './llm.mjs';
import { exportRun } from './export.mjs';
import { topology, attention } from './topology.mjs';

export async function runAnatomy(config, store, { out, fetchImpl, log = () => {} } = {}) {
  if (!config.source) return { status: 'idle', message: 'Set target in TARGET.json' };
  const started = Date.now(), deadline = started + config.budget.seconds * 1000;
  log('Capturing source...');
  const capture = await acquire(config, { fetchImpl, deadline, emit: (k, b) => store.event(k, b) });
  // Acquisition is repeated to detect edits; unchanged snapshots reuse all
  // extraction jobs. Partial snapshots never masquerade as complete coverage.
  const runId = shortHash({ config: config.id, snapshot: capture.snapshot, revision: capture.revision });
  store.start(runId, config.target);
  await store.event('run.started', { runId, engine: 'blindsight', snapshot: capture.snapshot, revision: capture.revision });
  const artifacts = capture.artifacts.map(a => store.putArtifact(runId, a.path, a.text, a.meta));
  for (const a of artifacts) {
    for (const w of workersFor(a)) store.enqueue(runId, w, { artifact: a.id }, w === 'structure' ? 10 : w === 'contracts' ? 9 : 5);
  }
  store.enqueue(runId, 'topology', { snapshot: capture.snapshot }, 0.8);
  if (config.llm.enabled) store.enqueue(runId, 'attention', { snapshot: capture.snapshot, model: config.llm.model, maxCalls: config.llm.maxCalls }, 0.5);
  let processed = 0, added = 0;
  const record = async (f, bounded = true) => {
    if (bounded && (Date.now() >= deadline || added >= config.budget.facts)) throw Object.assign(Error('Fact/time budget exhausted'), { code: 'BUDGET' });
    const result = store.putFact(runId, f); added += result.added;
    // Retry event emission even when the projection was already committed before
    // a crash. Event deduplication closes that projection/event crash window.
    await store.event('observation.seen', { engine: 'blindsight', runId, fact: result.fact }, `blindsight:${result.fact.id}`);
  };
  while (processed < config.budget.tasks && Date.now() < deadline) {
    const task = store.claim(runId); if (!task) break;
    try {
      if (task.worker === 'attention') {
        for (const a of attention(store.facts(runId), artifacts, config.llm.maxCalls)) store.enqueue(runId, 'llm', { artifact: a.id, model: config.llm.model }, 0.2);
      } else if (task.worker === 'topology') {
        for (const f of topology(store.facts(runId))) await record(f);
      } else if (task.worker === 'linker') {
        for (const f of linkImports(store.facts(runId), artifacts)) await record(f);
      } else {
        const a = store.artifact(task.payload.artifact);
        if (!a) throw Error('Task artifact missing');
        const facts = task.worker === 'llm' ? await infer(a, config.llm, { fetchImpl, timeout: Math.min(30000, deadline - Date.now()) }) : extract(task.worker, a);
        for (const f of facts) await record(f);
        // Stigmergy: dependencies written by one drone enqueue a distinct linker
        // task. Its lower priority waits for other extraction workers to finish.
        if (facts.some(f => f.predicate === 'imports')) store.enqueue(runId, 'linker', { snapshot: capture.snapshot }, 1);
      }
      store.complete(task.id);
    } catch (e) {
      if (e.code === 'BUDGET') { store.defer(task.id); break; }
      store.complete(task.id, e.message); log(`Worker ${task.worker} failed: ${e.message}`);
    }
    processed++;
    if (processed % 25 === 0) log(`${processed} tasks processed, ${added} new facts`);
  }
  // Missing behavior stays unknown, not inferred as absent.
  for (const [predicate, value] of [
    ['runtimeBehavior', 'No dynamic execution or behavioral equivalence verification performed'],
    ['hiddenComponents', 'Private backends, deployment state and components absent from captured sources are unknown'],
    ['parserCoverage', 'Lexical source analysis plus JSON structure; not a complete AST or language semantics engine']
  ]) await record({ entity: `target:${runId}`, layer: 'unknowns', predicate, value, status: 'unknown', evidence: [], producer: 'coverage' }, false);
  const tasks = store.tasks(runId), pending = tasks.filter(t => ['pending','running'].includes(t.state)).length, failed = tasks.filter(t => t.state === 'failed');
  const status = !artifacts.length ? 'empty' : pending ? 'budget' : failed.length || capture.limits.length ? 'partial' : 'quiescent';
  const summary = { status, runId, snapshot: capture.snapshot, revision: capture.revision, files: artifacts.length, bytes: capture.bytes, processed, newFacts: added, pending, failed: failed.map(t => ({ worker: t.worker, error: t.error })), limits: [...capture.limits, ...(pending ? ['task-fact-or-time-budget'] : [])], skipped: capture.skipped, network: capture.network, elapsedMs: Date.now() - started, modelEnabled: config.llm.enabled, plateau: status === 'quiescent' ? 'Available worker frontier exhausted, not universal understanding' : 'Not reached; see limits and failures' };
  store.finish(runId, status, summary);
  await store.event('run.completed', { engine: 'blindsight', ...summary });
  const exportPath = path.join(out, runId);
  const exported = exportRun(store, runId, exportPath, { replica: config.mode === 'replica' });
  fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify({ runId, path: runId, status }, null, 2));
  return { ...summary, ...exported };
}

export async function importModelResults(store, runId, filename) {
  let added = 0;
  for (const line of fs.readFileSync(filename, 'utf8').split('\n').filter(Boolean)) {
    const result = JSON.parse(line), artifact = store.artifact(result.artifact);
    if (!artifact || artifact.run_id !== runId) throw Error('Model result references wrong run or artifact');
    for (const f of validateProposals(result, artifact)) {
      const r = store.putFact(runId, f); added += r.added;
      await store.event('observation.seen', { engine: 'blindsight', runId, fact: r.fact }, `blindsight:${r.fact.id}`);
    }
  }
  return { added };
}

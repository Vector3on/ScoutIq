// core/bundle.mjs — the paste-ready context bundle and its return channel.
//
// The bundle is how heavy reasoning (a human, or a model on a subscription)
// plugs into the substrate at $0: it carries the prioritized novel findings
// with evidence, the items the substrate is least sure about, its current
// strategies, and a strict reply format. `parseJudgments` turns the reply
// into judgment / strategy-seed / note events, which the value function and
// the archive consume on the next run. The reasoner becomes a sensor.
import { project } from './projections.mjs';
import { memoryProjection, seriesLatest } from './memory.mjs';
import { archiveProjection } from './archive.mjs';
import { qdProjection, coverage, qdScore } from './qd.mjs';
import { makePlannerProjection } from './planner.mjs';
import { normalizeGenome } from './strategy.mjs';
import { runSeries } from './metrics.mjs';

export function genomeOneLiner(g) {
  const seed = `${g.seed.op}(${g.seed.type}${g.seed.days ? `, ${g.seed.days}d` : ''}${g.seed.signal ? `, ${g.seed.signal}` : ''})`;
  const pipe = (g.pipe ?? []).map((p) => `${p.op}(${Object.entries(p).filter(([k]) => k !== 'op').map(([k, v]) => `${k}=${v}`).join(',')})`).join(' → ');
  return `${seed}${pipe ? ' → ' + pipe : ''} → rank:${g.rank.by}${g.rank.signal ? ':' + g.rank.signal : ''}`;
}

export async function buildBundle(store, { domain, top = 15, uncertain = 6, runs = 3, now = Date.now() }) {
  const [mem, arch, qd, plan] = await Promise.all([
    project(store, memoryProjection, { domain, saveSnapshot: false }),
    project(store, archiveProjection, { domain, saveSnapshot: false }),
    project(store, qdProjection, { domain, saveSnapshot: false }),
    project(store, makePlannerProjection(), { domain, saveSnapshot: false }),
  ]);
  const memory = mem.state, archive = arch.state, qdState = qd.state, planner = plan.state;
  const series = await runSeries(store, domain);
  const last = series[series.length - 1];
  const recentRuns = new Set(series.slice(-runs).map((r) => r.runId));
  const findings = archive.recent.filter((f) => recentRuns.has(f.runId));
  const byEntity = new Map();
  for (const f of findings) if (!byEntity.has(f.entityId) || byEntity.get(f.entityId).score < f.score) byEntity.set(f.entityId, f);
  const ranked = [...byEntity.values()].sort((a, b) => b.score - a.score);
  const topF = ranked.slice(0, top);
  const unsure = ranked.filter((f) => !topF.includes(f) && !archive.judgments.has(f.entityId)).map((f) => ({ f, u: (f.value ?? 0) * (1 - (f.value ?? 0)) })).sort((a, b) => b.u - a.u).slice(0, uncertain).map((x) => x.f);
  const L = [];
  L.push(`# Loam context bundle — domain \`${domain}\` — ${new Date(now).toISOString().slice(0, 16)}Z`, '');
  L.push('## How to use this', '', 'You are reading the state of an autonomous, observe-only intelligence substrate. It ingests public data, evolves ways of looking at its memory, and delivers findings it believes are both valuable and NEW. It never acts on outside systems. Please:', '', '1. Rate the findings below (0 = noise, 1 = important). Ratings recalibrate the substrate\'s value model.', '2. Answer the open questions where you can.', '3. Optionally propose a strategy the archive lacks, in the DSL shown under *Strategy archive*.', '', 'Reply ONLY with the block format given at the end; it is parsed mechanically.', '');
  L.push('## Status', '');
  L.push(`- runs: ${series.length}; entities: ${memory.entities.size}; relations: ${memory.relations.size}; observations: ${memory.obsCount}; vocabulary: ${memory.terms.df.size}`);
  L.push(`- strategy archive: ${qdState.cells.size} elites (coverage ${(coverage(qdState) * 100).toFixed(1)}%), QD-score ${qdScore(qdState).toFixed(2)}, ${qdState.evaluations} evaluations`);
  if (last) L.push(`- last run ${last.runId}: ${last.findings} findings, novel value ${last.novelValue}, ${last.newObservations} new observations, ${last.requests} requests, ${last.denials} policy denials, ${last.activeBlocks} active host blocks`);
  L.push(`- judgments on record: ${archive.judgments.size}; human-seeded strategies: ${archive.seeded.length}`, '');
  L.push(`## Top findings (last ${runs} runs)`, '');
  if (!topF.length) L.push('_none yet_', '');
  for (const f of topF) {
    const e = memory.entities.get(f.entityId);
    const elite = f.cell ? qdState.cells.get(f.cell) : null;
    L.push(`### [${f.findingId}] ${f.title || f.entityId}`);
    L.push(`- entity: \`${f.entityId}\` · score ${fmt(f.score)} (value ${fmt(f.value)} × novelty ${fmt(f.novelty)})`);
    if (e) {
      const sig = [...e.signals].map(([k, s]) => `${k}=${fmt(seriesLatest(s)?.[1])}`).join(', ');
      const rels = countRels(memory, f.entityId);
      L.push(`- evidence: first seen ${new Date(e.firstSeen).toISOString().slice(0, 10)}, last ${new Date(e.lastSeen).toISOString().slice(0, 10)}, ${e.n} observations${sig ? '; signals ' + sig : ''}${rels ? '; links ' + rels : ''}`);
      const attrs = Object.entries(e.attrs ?? {}).slice(0, 6).map(([k, v]) => `${k}=${String(v).slice(0, 60)}`).join(', ');
      if (attrs) L.push(`- attributes: ${attrs}`);
    }
    const why = findingRationale(store, f);
    if (why) L.push(`- why: ${why}`);
    if (elite) L.push(`- found by strategy \`${f.strategyId}\` (cell ${f.cell}): ${genomeOneLiner(elite.genome)}`);
    L.push('');
  }
  const requested = (await store.readAll({ domain, kinds: ['judgment.requested'] })).filter((e) => recentRuns.has(e.body.runId)).at(-1);
  if (requested && requested.body.items?.length) {
    L.push('## Please judge these first', '', `The substrate asked for these (${requested.body.items[0].reason}); each answer is expected to change what it delivers next.`, '');
    for (const it of requested.body.items) L.push(`- ${it.findingId ? `[${it.findingId}] ` : `entity \`${it.entityId}\` `}${it.title} — estimated ${fmt(it.score)}${it.priority !== undefined ? `, priority ${fmt(it.priority)}` : ''}`);
    L.push('');
  }
  if (unsure.length) {
    L.push('## Where the substrate is least sure', '', 'Mid-range value estimates; a rating here is worth the most.', '');
    for (const f of unsure) L.push(`- [${f.findingId}] ${f.title || f.entityId} — value ${fmt(f.value)}, novelty ${fmt(f.novelty)}`);
    L.push('');
  }
  L.push('## Attention', '');
  L.push(`- planner outcomes: ${planner.outcomes}; runs: ${planner.runs}`);
  for (const [sensor, m] of planner.sensorStats) {
    const rows = [...m.entries()].sort((a, b) => b[1].ySum - a[1].ySum).slice(0, 8).map(([k, s]) => `${k} (${s.polls} polls, ${s.newObs} new, y≈${fmt(s.ySum / Math.max(1, s.polls))})`);
    L.push(`- ${sensor}: ${rows.join('; ') || 'no polls yet'}`);
  }
  L.push('');
  L.push('## Strategy archive (elites by behavior cell: age-centrality-spread)', '');
  const elites = [...qdState.cells.entries()].sort((a, b) => b[1].fitness - a[1].fitness).slice(0, 12);
  for (const [cell, e] of elites) L.push(`- ${cell} · fitness ${fmt(e.fitness)} · \`${genomeOneLiner(e.genome)}\``);
  L.push('', 'DSL: seed ∈ {recent(type,days), all(type), stale(type,minDays), top(type,signal,n)}; pipe ops ∈ {expand, viaNewEdge, filterSignal, filterAge, filterDegree, bridge(mode=emerging|rare), newcomer, accelerating, silent, outlier, rareTerms, rising, limit}; rank ∈ {value, surprisal, burst, recency, degree, signal, age, mixed}.', '');
  L.push('## Open questions', '', '1. Which of the top findings are noise, and why? (Your reason helps more than the number.)', '2. Which sensor or query deserves more attention, and which is wasted?', '3. What kind of finding is missing entirely from the archive above?', '');
  L.push('## Reply format', '', '```loam-judgment', 'finding <findingId> <0..1> <optional note>', 'entity <entityId> <0..1> <optional note>', 'strategy {"seed":{"op":"recent","type":"...","days":7},"pipe":[{"op":"newcomer","rel":"...","dir":"out","recentDays":7,"priorDays":30}],"rank":{"by":"value"}}', 'note <free text observation>', '```', '');
  return L.join('\n');
}

function countRels(memory, id) {
  const parts = [];
  for (const [rel, s] of memory.out.get(id) ?? []) parts.push(`${rel}→${s.size}`);
  for (const [rel, s] of memory.in.get(id) ?? []) parts.push(`←${rel} ${s.size}`);
  return parts.join(', ');
}
function findingRationale(store, f) { return f.rationale ? f.rationale.join('; ') : null; }
const fmt = (x) => (Number.isFinite(x) ? Number(x).toFixed(2) : '?');

/** Parse `loam-judgment` blocks from a reply. Returns { judgments, strategies, notes, errors }. */
export function parseJudgments(text) {
  const out = { judgments: [], strategies: [], notes: [], errors: [] };
  const blocks = [...String(text).matchAll(/```loam-judgment\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const body = blocks.length ? blocks.join('\n') : text;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let m;
    if ((m = /^(finding|entity)\s+(\S+)\s+([01](?:\.\d+)?|\.\d+)\s*(.*)$/.exec(line))) {
      const value = Number(m[3]);
      if (!(value >= 0 && value <= 1)) { out.errors.push(`value out of range: ${line}`); continue; }
      out.judgments.push({ kind: m[1], id: m[2], value, note: m[4].trim().slice(0, 500) });
    } else if ((m = /^strategy\s+(\{.*\})\s*$/.exec(line))) {
      try {
        const g = normalizeGenome(JSON.parse(m[1]));
        if (!g.seed?.op || !g.seed?.type) throw new Error('seed.op/type required');
        out.strategies.push(g);
      } catch (e) { out.errors.push(`bad strategy: ${e.message}`); }
    } else if ((m = /^note\s+(.+)$/.exec(line))) {
      out.notes.push(m[1].trim().slice(0, 2000));
    } else {
      out.errors.push(`unrecognised line: ${line.slice(0, 80)}`);
    }
  }
  return out;
}

/** Turn parsed judgments into events via a ledger. */
export async function ingestJudgments(ledger, parsed, { archive, by = 'human', now = Date.now() }) {
  let n = 0;
  const findingToEntity = new Map(archive.recent.map((f) => [f.findingId, f.entityId]));
  for (const j of parsed.judgments) {
    const entityId = j.kind === 'entity' ? j.id : findingToEntity.get(j.id) ?? null;
    if (!entityId) { parsed.errors.push(`unknown finding ${j.id}`); continue; }
    await ledger.emit('judgment.recorded', { findingId: j.kind === 'finding' ? j.id : null, entityId, value: j.value, note: j.note, by, ts: now });
    n++;
  }
  for (const g of parsed.strategies) { await ledger.emit('strategy.seeded', { genome: g, by, ts: now }); n++; }
  for (const t of parsed.notes) { await ledger.emit('note.recorded', { text: t, by, ts: now }); n++; }
  return n;
}

// core/archive.mjs — the finding archive: what has already been delivered, so
// that "novel" has a precise meaning: not reported within the window, and
// semantically distant from what was reported recently.
import { Projection, mapToArr, arrToMap } from './projections.mjs';
import { cosine } from './embed.mjs';
import { DAY_MS } from './memory.mjs';

export const archiveProjection = new Projection({
  name: 'archive',
  version: 2,
  kinds: ['finding.emitted', 'judgment.recorded', 'strategy.seeded', 'note.recorded'],
  init: () => ({ total: 0, ids: new Set(), byEntity: new Map(), recent: [], byStrategy: new Map(), byCell: new Map(), byRun: new Map(), judgments: new Map(), seeded: [], notes: [] }),
  apply(state, ev) {
    const b = ev.body;
    if (ev.kind === 'finding.emitted') {
      if (state.ids.has(b.findingId)) return;
      state.ids.add(b.findingId);
      state.total++;
      const prev = state.byEntity.get(b.entityId);
      if (!prev || prev.last < b.ts) state.byEntity.set(b.entityId, { last: b.ts, count: (prev?.count ?? 0) + 1, lastScore: b.score, lastFindingId: b.findingId });
      else prev.count++;
      state.recent.push({ findingId: b.findingId, entityId: b.entityId, title: b.title ?? '', ts: b.ts, cell: b.cell ?? null, strategyId: b.strategyId ?? null, score: b.score, value: b.value, novelty: b.novelty, runId: b.runId ?? null });
      if (state.recent.length > 1000) state.recent.splice(0, state.recent.length - 1000);
      if (b.strategyId) state.byStrategy.set(b.strategyId, (state.byStrategy.get(b.strategyId) ?? 0) + 1);
      if (b.cell) state.byCell.set(b.cell, (state.byCell.get(b.cell) ?? 0) + 1);
      if (b.runId) state.byRun.set(b.runId, (state.byRun.get(b.runId) ?? 0) + 1);
    } else if (ev.kind === 'judgment.recorded') {
      const key = b.entityId || b.findingId; // keyed by entity so value lookups by entity id find it
      if (!key) return;
      const prev = state.judgments.get(key);
      if (!prev || prev.ts < b.ts) state.judgments.set(key, { value: b.value, by: b.by ?? 'human', note: b.note ?? '', ts: b.ts, entityId: b.entityId ?? null, findingId: b.findingId ?? null });
    } else if (ev.kind === 'strategy.seeded') {
      state.seeded.push({ genome: b.genome, by: b.by ?? 'human', ts: b.ts ?? ev.ts, id: ev.id });
      if (state.seeded.length > 200) state.seeded.splice(0, state.seeded.length - 200);
    } else if (ev.kind === 'note.recorded') {
      state.notes.push({ text: b.text, by: b.by ?? 'human', ts: b.ts ?? ev.ts });
      if (state.notes.length > 200) state.notes.splice(0, state.notes.length - 200);
    }
  },
  dehydrate: (s) => ({ total: s.total, ids: [...s.ids], byEntity: mapToArr(s.byEntity), recent: s.recent, byStrategy: mapToArr(s.byStrategy), byCell: mapToArr(s.byCell), byRun: mapToArr(s.byRun), judgments: mapToArr(s.judgments), seeded: s.seeded, notes: s.notes }),
  hydrate: (j) => ({ total: j.total, ids: new Set(j.ids), byEntity: arrToMap(j.byEntity), recent: j.recent ?? [], byStrategy: arrToMap(j.byStrategy), byCell: arrToMap(j.byCell), byRun: arrToMap(j.byRun), judgments: arrToMap(j.judgments), seeded: j.seeded ?? [], notes: j.notes ?? [] }),
});

/**
 * Novelty of reporting `entityId` now.
 *   hard ∈ {0,1}: 1 unless the entity was reported within `windowDays`.
 *   soft ∈ [0,1]: 1 − max cosine to recent findings' vectors (semantic redundancy).
 *   novelty = hard × (0.25 + 0.75 × soft)
 */
export function noveltyOf(archive, { entityId, vec = null, now, windowDays = 30, recentVecs = [] }) {
  const prev = archive.byEntity.get(entityId);
  const hard = prev && prev.last > now - windowDays * DAY_MS ? 0 : 1;
  let maxSim = 0;
  if (vec && recentVecs.length) for (const rv of recentVecs) { const s = cosine(vec, rv); if (s > maxSim) maxSim = s; }
  const soft = Math.max(0, 1 - maxSim);
  return { hard, soft, novelty: hard * (0.25 + 0.75 * soft), reportedBefore: prev ? prev.count : 0 };
}

/** Strategy-usage entropy (bits) over the findings of the last `runs` runs. */
export function strategyEntropy(archive, { lastN = 100 } = {}) {
  const recent = archive.recent.slice(-lastN);
  const counts = new Map();
  for (const f of recent) counts.set(f.strategyId ?? '?', (counts.get(f.strategyId ?? '?') ?? 0) + 1);
  const n = recent.length;
  if (!n) return 0;
  let h = 0;
  for (const c of counts.values()) { const p = c / n; h -= p * Math.log2(p); }
  return h;
}

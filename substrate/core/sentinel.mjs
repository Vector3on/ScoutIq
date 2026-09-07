// core/sentinel.mjs — the plateau sentinel (v3).
//
// A projection over run.completed that detects stagnation live — value per
// second no longer trending up, archive cells no longer being added, novel
// value decaying — and a rotation of interventions the worker applies when it
// fires: raise the mutation temperature, open a new frontier challenge, widen
// the behavior space (use the learned archive's elites as parents). Every
// intervention is an event with a TTL, so its effect is measurable afterwards.
import { Projection } from './projections.mjs';
import { spearman } from './experiment.mjs';

export const INTERVENTIONS = ['temperature', 'frontier', 'descriptor'];
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

export function makeSentinelProjection({ keep = 128 } = {}) {
  return new Projection({
    name: 'sentinel',
    version: 1,
    kinds: ['run.completed', 'sentinel.intervened'],
    init: () => ({ runs: [], runIndex: 0, interventions: [], lastInterventionIndex: -Infinity }),
    apply(state, ev) {
      const b = ev.body;
      if (ev.kind === 'run.completed') {
        state.runIndex++;
        state.runs.push({ runId: b.runId, index: state.runIndex, valuePerSecond: b.valuePerSecond ?? 0, novelValue: b.novelValue ?? 0, coverage: b.coverage ?? 0, cells: b.archiveCells ?? 0, findings: b.findings ?? 0, ts: b.startedAt ?? ev.ts });
        if (state.runs.length > keep) state.runs.splice(0, state.runs.length - keep);
      } else {
        state.interventions.push({ runId: b.runId, action: b.action, params: b.params ?? {}, ttlRuns: b.ttlRuns ?? 4, atIndex: state.runIndex, trigger: b.trigger ?? null, ts: b.ts ?? ev.ts });
        state.lastInterventionIndex = state.runIndex;
        if (state.interventions.length > keep) state.interventions.splice(0, state.interventions.length - keep);
      }
    },
    dehydrate: (s) => ({ runs: s.runs, runIndex: s.runIndex, interventions: s.interventions, lastInterventionIndex: Number.isFinite(s.lastInterventionIndex) ? s.lastInterventionIndex : null }),
    hydrate: (j) => ({ runs: j.runs, runIndex: j.runIndex, interventions: j.interventions, lastInterventionIndex: j.lastInterventionIndex ?? -Infinity }),
  });
}

/** Interventions whose TTL has not elapsed at the current run index. */
export function activeInterventions(state) {
  return state.interventions.filter((i) => state.runIndex - i.atIndex < i.ttlRuns);
}

/** Stagnation diagnosis over the trailing window. */
export function diagnose(state, { window = 8, minRuns = 12 } = {}) {
  const runs = state.runs;
  if (runs.length < minRuns) return { stagnant: false, reason: 'warming-up', n: runs.length };
  const w = runs.slice(-window);
  const idx = w.map((_, i) => i);
  const trend = spearman(idx, w.map((r) => r.valuePerSecond));
  const cellsDelta = w[w.length - 1].cells - w[0].cells;
  const half = Math.floor(w.length / 2);
  const early = mean(w.slice(0, half).map((r) => r.novelValue)), late = mean(w.slice(half).map((r) => r.novelValue));
  const novelValueRatio = early > 0 ? late / early : 1;
  const reasons = [];
  if (trend <= 0.1) reasons.push('value-per-second-flat');
  if (cellsDelta <= 1) reasons.push('archive-saturated');
  if (novelValueRatio < 0.95) reasons.push('novel-value-decaying');
  return { stagnant: reasons.length >= 2, reasons, trend: Number(trend.toFixed(3)), cellsDelta, novelValueRatio: Number(novelValueRatio.toFixed(3)), n: runs.length };
}

/** Rotate through the intervention menu; returns null during cooldown. */
export function nextIntervention(state, { cooldown = 6, menu = INTERVENTIONS } = {}) {
  if (state.runIndex - state.lastInterventionIndex < cooldown) return null;
  if (activeInterventions(state).length) return null;
  const n = state.interventions.length;
  const action = menu[n % menu.length];
  const params = action === 'temperature' ? { randomGenomes: 8, mutationStrength: 2 } : action === 'frontier' ? { newChallenges: 1 } : { descriptor: 'both', maxEvolveCandidates: 60 };
  return { action, params, ttlRuns: action === 'descriptor' ? 8 : 4 };
}

/** Before/after effect of each intervention on value per second and cells. */
export function interventionEffects(state, { window = 6 } = {}) {
  return state.interventions.map((i) => {
    const before = state.runs.filter((r) => r.index <= i.atIndex && r.index > i.atIndex - window);
    const after = state.runs.filter((r) => r.index > i.atIndex && r.index <= i.atIndex + window);
    return { action: i.action, atIndex: i.atIndex, reasons: i.trigger?.reasons ?? [], valueBefore: Number(mean(before.map((r) => r.valuePerSecond)).toFixed(4)), valueAfter: Number(mean(after.map((r) => r.valuePerSecond)).toFixed(4)), cellsBefore: before.at(-1)?.cells ?? null, cellsAfter: after.at(-1)?.cells ?? null, complete: after.length >= window };
  });
}

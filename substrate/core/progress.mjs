// core/progress.mjs — learning progress and second-order novelty (v4;
// DESIGN.md §10). A fold over run.completed that tracks, per mechanism, how
// fast the substrate is still learning:
//
//   value model   — learning progress = the negative slope of its hindsight
//                   calibration error over the trailing window (Schmidhuber-
//                   style compression progress: the model keeps getting better
//                   at predicting what its own future will say);
//   discovery     — the adoption rate of new observables and, one level up,
//                   the rate of NEW KINDS of observables (program shapes never
//                   adopted before): second-order novelty — new ways of
//                   measuring, not just new measurements;
//   curriculum    — environments solved per run.
//
// A frontier STALL is declared when adoption and shape novelty have both been
// zero for a window and the value model's progress is ≤ 0: the information
// frontier has stopped moving under the current grammar. The worker reports
// it and, if `progress: true`, raises the discovery temperature for a while so
// the effect of the intervention is measurable afterwards.
import { Projection } from './projections.mjs';

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

/** Least-squares slope of ys over their index. */
export function slope(ys) {
  const n = ys.length;
  if (n < 3) return 0;
  const mx = (n - 1) / 2, my = mean(ys);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (i - mx) * (ys[i] - my); sxx += (i - mx) ** 2; }
  return sxx ? sxy / sxx : 0;
}

export function makeProgressProjection({ keep = 200 } = {}) {
  return new Projection({
    name: 'progress',
    version: 1,
    kinds: ['run.completed'],
    init: () => ({ runs: [], index: 0, shapes: new Set(), stalls: 0, interventions: [] }),
    apply(state, ev) {
      const b = ev.body, v4 = b.v4 ?? {};
      state.index++;
      const adoptedThisRun = v4.observables?.adoptedThisRun ?? 0;
      const newShapes = v4.observables?.newShapesThisRun ?? 0;
      state.runs.push({
        index: state.index, runId: b.runId, ts: b.startedAt ?? ev.ts,
        hindMae: v4.hindsight?.mae ?? null, vmMae: b.valueModel?.mae ?? null, labelMae: v4.hindsight?.labelMae ?? null,
        adopted: adoptedThisRun, newShapes, totalAdopted: v4.observables?.adopted ?? 0, solved: v4.curriculum?.solvedThisRun ?? 0,
        valuePerSecond: b.valuePerSecond ?? 0, novelValue: b.novelValue ?? 0, ig: v4.hindsight?.ig ?? 0,
      });
      if (v4.progress?.intervened) { state.interventions.push({ index: state.index, action: v4.progress.intervened, ttl: v4.progress.ttl ?? 4 }); }
      if (state.runs.length > keep) state.runs.splice(0, state.runs.length - keep);
    },
    dehydrate: (s) => ({ runs: s.runs, index: s.index, shapes: [...s.shapes], stalls: s.stalls, interventions: s.interventions }),
    hydrate: (j) => ({ runs: j.runs, index: j.index, shapes: new Set(j.shapes), stalls: j.stalls, interventions: j.interventions ?? [] }),
  });
}

/** Diagnosis over the trailing window. */
export function diagnoseProgress(state, { window = 8, minRuns = 10 } = {}) {
  const runs = state.runs;
  if (runs.length < minRuns) return { stalled: false, reason: 'warming-up', n: runs.length };
  const w = runs.slice(-window);
  const maes = w.map((r) => r.hindMae ?? r.vmMae).filter((x) => x !== null && x !== undefined);
  const lpValue = maes.length >= 3 ? -slope(maes) : 0;            // > 0: calibration error still falling
  const adoptions = w.reduce((s, r) => s + r.adopted, 0);
  const newShapes = w.reduce((s, r) => s + r.newShapes, 0);
  const solved = w.reduce((s, r) => s + r.solved, 0);
  const stalled = adoptions === 0 && newShapes === 0 && lpValue <= 1e-4;
  return { stalled, lpValue: Number(lpValue.toFixed(5)), adoptions, newShapes, solved, adoptionRate: Number((adoptions / w.length).toFixed(3)), shapeRate: Number((newShapes / w.length).toFixed(3)), igMean: Number(mean(w.map((r) => r.ig)).toFixed(3)), n: runs.length };
}

/** Interventions whose TTL has not elapsed. */
export const activeProgressInterventions = (state) => state.interventions.filter((i) => state.index - i.index < i.ttl);

/** Before/after effect of each intervention on adoptions and hindsight error. */
export function progressEffects(state, { window = 6 } = {}) {
  return state.interventions.map((i) => {
    const before = state.runs.filter((r) => r.index <= i.index && r.index > i.index - window);
    const after = state.runs.filter((r) => r.index > i.index && r.index <= i.index + window);
    const m = (rs, f) => mean(rs.map(f).filter((x) => x !== null));
    return { action: i.action, atIndex: i.index, adoptionsBefore: before.reduce((s, r) => s + r.adopted, 0), adoptionsAfter: after.reduce((s, r) => s + r.adopted, 0), hindMaeBefore: Number(m(before, (r) => r.hindMae).toFixed(4)), hindMaeAfter: Number(m(after, (r) => r.hindMae).toFixed(4)), complete: after.length >= window };
  });
}

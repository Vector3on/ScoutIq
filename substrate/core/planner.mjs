// core/planner.mjs — the planner projection: folds action outcomes into the
// attention model, tracks per-type cost estimates and outcome scales, and
// keeps per-sensor/params statistics so sensors can propose informed queries.
import { Projection, mapToArr, arrToMap } from './projections.mjs';
import { LinearModel, featurize } from './attention.mjs';

export const DIM = 128;

export function makePlannerProjection({ dim = DIM, priorVar = 1.0, noiseVar = 0.25, forgetting = 0.98 } = {}) {
  return new Projection({
    name: 'planner',
    version: 3,
    kinds: ['action.outcome', 'run.completed'],
    init: () => ({ model: new LinearModel({ dim, priorVar, noiseVar, forgetting }), costs: new Map(), scales: new Map(), sensorStats: new Map(), outcomes: 0, runs: 0, byType: new Map() }),
    apply(state, ev) {
      if (ev.kind === 'run.completed') { state.runs++; state.model.forget(); return; }
      const b = ev.body;
      const type = b.type;
      // normalise the raw outcome by a slowly-decaying running maximum per action type
      const scale = state.scales.get(type) ?? 0;
      const raw = Math.max(0, Number(b.raw) || 0);
      const y = scale > 1e-9 ? Math.min(1, raw / scale) : raw > 0 ? 1 : 0;
      state.scales.set(type, Math.max(scale * 0.995, raw));
      state.model.update(featurize(b.features, state.model.dim), y);
      state.outcomes++;
      const c = state.costs.get(type) ?? { ema: null, n: 0 };
      const sec = Math.max(0.001, (Number(b.ms) || 0) / 1000);
      c.ema = c.ema === null ? sec : c.ema * 0.8 + sec * 0.2;
      c.n++;
      state.costs.set(type, c);
      const t = state.byType.get(type) ?? { n: 0, ySum: 0, rawSum: 0 };
      t.n++; t.ySum += y; t.rawSum += raw;
      state.byType.set(type, t);
      if (b.sensor) {
        let m = state.sensorStats.get(b.sensor);
        if (!m) { m = new Map(); state.sensorStats.set(b.sensor, m); }
        const key = b.paramsKey ?? '*';
        const s = m.get(key) ?? { polls: 0, obs: 0, newObs: 0, lastAt: 0, lastY: 0, ySum: 0 };
        s.polls++; s.obs += b.obs ?? 0; s.newObs += b.newObs ?? 0; s.lastAt = Math.max(s.lastAt, b.ts ?? ev.ts); s.lastY = y; s.ySum += y;
        m.set(key, s);
      }
    },
    dehydrate: (s) => ({ model: s.model.toState(), costs: mapToArr(s.costs), scales: mapToArr(s.scales), sensorStats: mapToArr(s.sensorStats, (m) => mapToArr(m)), outcomes: s.outcomes, runs: s.runs, byType: mapToArr(s.byType) }),
    hydrate: (j) => ({ model: LinearModel.fromState(j.model), costs: arrToMap(j.costs), scales: arrToMap(j.scales), sensorStats: arrToMap(j.sensorStats, (a) => arrToMap(a)), outcomes: j.outcomes, runs: j.runs, byType: arrToMap(j.byType) }),
  });
}

export function estimateCost(planner, type, fallbackSec) {
  const c = planner.costs.get(type);
  return c && c.ema !== null && c.n >= 2 ? c.ema : fallbackSec;
}

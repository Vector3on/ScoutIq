// core/credit.mjs — delayed credit assignment (v3; DECISIONS D9).
//
// When a finding is delivered, its score is attributed back through the log
// to the (sensor, params) polls that observed its entity — and, at a lower
// weight, the polls that observed its neighbours — with recency decay. Each
// credit becomes an extra outcome for the attention model under the features
// the poll had when it ran, so attention learns to reward groundwork.
//
// provenanceProjection folds observation.seen + action.outcome (existing kinds)
// into entity → contributors and (sensor, params) → last features. The planner
// variant adds credit.assigned to the v2 planner fold; on a log with no credit
// events its state equals the v2 planner's.
import { Projection, mapToArr, arrToMap } from './projections.mjs';
import { makePlannerProjection } from './planner.mjs';
import { featurize } from './attention.mjs';
import { DAY_MS } from './memory.mjs';

const MAX_CONTRIB = 8;

export const provenanceProjection = new Projection({
  name: 'provenance',
  version: 1,
  kinds: ['observation.seen', 'action.outcome'],
  init: () => ({ byEntity: new Map(), lastFeatures: new Map(), seen: new Set() }),
  apply(state, ev) {
    const b = ev.body;
    if (ev.kind === 'action.outcome') {
      if (b.sensor && b.paramsKey && b.features) state.lastFeatures.set(`${b.sensor}|${b.paramsKey}`, { features: b.features, ts: b.ts ?? ev.ts, type: b.type });
      return;
    }
    const key = ev.dedupKey ?? ev.id;
    if (state.seen.has(key)) return;
    state.seen.add(key);
    if (!b.sensor || !b.params) return;
    const t = Number.isFinite(b.observedAt) ? b.observedAt : ev.ts;
    for (const spec of b.entities ?? []) {
      if (!spec?.type || spec.key === undefined) continue;
      const id = `${spec.type}:${spec.key}`;
      let arr = state.byEntity.get(id);
      if (!arr) { arr = []; state.byEntity.set(id, arr); }
      const k = `${b.sensor}|${b.params}`;
      const i = arr.findIndex((x) => x.key === k);
      if (i >= 0) { arr[i].ts = Math.max(arr[i].ts, t); arr[i].n++; }
      else { arr.push({ key: k, sensor: b.sensor, paramsKey: b.params, ts: t, n: 1 }); if (arr.length > MAX_CONTRIB) arr.splice(0, arr.length - MAX_CONTRIB); }
    }
  },
  dehydrate: (s) => ({ byEntity: mapToArr(s.byEntity), lastFeatures: mapToArr(s.lastFeatures), seen: [...s.seen] }),
  hydrate: (j) => ({ byEntity: arrToMap(j.byEntity), lastFeatures: arrToMap(j.lastFeatures), seen: new Set(j.seen) }),
});

/** Credits for one delivered finding. Total credit equals the finding's score. */
export function assignCredit(finding, { provenance, memory, now, hops = 1, neighborWeight = 0.3, decayDays = 30 }) {
  const contrib = new Map();
  const add = (id, w) => {
    for (const c of provenance.byEntity.get(id) ?? []) {
      const age = Math.max(0, now - c.ts) / DAY_MS;
      const weight = w * Math.exp(-age / decayDays);
      const prev = contrib.get(c.key);
      if (!prev || prev.weight < weight) contrib.set(c.key, { sensor: c.sensor, paramsKey: c.paramsKey, weight, hops: w === 1 ? 0 : 1 });
    }
  };
  add(finding.entityId, 1);
  if (hops >= 1) {
    for (const m of memory.out.get(finding.entityId)?.values() ?? []) for (const n of m) add(n, neighborWeight);
    for (const m of memory.in.get(finding.entityId)?.values() ?? []) for (const n of m) add(n, neighborWeight);
  }
  const total = [...contrib.values()].reduce((s, c) => s + c.weight, 0);
  if (!total) return [];
  return [...contrib.values()].map((c) => {
    const lf = provenance.lastFeatures.get(`${c.sensor}|${c.paramsKey}`);
    return { sensor: c.sensor, paramsKey: c.paramsKey, amount: Number((finding.score * c.weight / total).toFixed(5)), weight: Number(c.weight.toFixed(4)), hops: c.hops, features: lf?.features ?? null, type: lf?.type ?? `poll:${c.sensor}` };
  }).filter((c) => c.amount > 0);
}

/** The v2 planner fold plus credit.assigned. Same state on a log without credit events. */
export function makePlannerCreditProjection(opts = {}) {
  const base = makePlannerProjection(opts);
  return new Projection({
    name: 'planner-credit',
    version: 1,
    kinds: ['action.outcome', 'run.completed', 'credit.assigned'],
    init: () => ({ ...base.init(), credits: new Map(), credited: 0 }),
    apply(state, ev) {
      if (ev.kind !== 'credit.assigned') return base.apply(state, ev);
      const b = ev.body;
      if (!b.features || !(b.amount > 0)) return;
      // Credit has its own running scale per sensor: "relative to the best groundwork
      // this sensor ever produced", so delayed value is not drowned by immediate yield.
      const ctype = `credit:${b.type ?? `poll:${b.sensor}`}`;
      const scale = state.scales.get(ctype) ?? 0;
      const y = scale > 1e-9 ? Math.min(1, b.amount / scale) : 1;
      state.scales.set(ctype, Math.max(scale * 0.995, b.amount));
      state.model.update(featurize(b.features, state.model.dim), y);
      state.credited++;
      const key = `${b.sensor}|${b.paramsKey}`;
      state.credits.set(key, (state.credits.get(key) ?? 0) + b.amount);
      const m = state.sensorStats.get(b.sensor);
      const s = m?.get(b.paramsKey);
      if (s) { s.credit = (s.credit ?? 0) + b.amount; s.ySum += y * 0.5; }
    },
    dehydrate: (s) => ({ ...base.dehydrate(s), credits: mapToArr(s.credits), credited: s.credited }),
    hydrate: (j) => ({ ...base.hydrate(j), credits: arrToMap(j.credits ?? []), credited: j.credited ?? 0 }),
  });
}

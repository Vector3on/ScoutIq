// core/valuemodel-v4.mjs — the value model that learns from hindsight and
// from discovered observables (v4; DESIGN.md §10). Additive: the v3
// projection (core/valuemodel.mjs) is untouched; this one folds the same two
// kinds plus hindsight.labeled and observable.{proposed,adopted,retired}, and
// on a log without those kinds its model equals the v3 model.
//
//   value(x) = clamp( pluginScore(x) + wᵀφ(x) ),   φ = base features ⊕ adopted observables (bucketed)
//
// Rows. Every labelled observation is kept as a row {features, obs, target,
// precision}: a judgment row (precision 1/σ_j²) or a hindsight row whose
// target is the label model's calibrated value and whose precision is the
// inverse of that label's variance. Precision-weighted updates are exact for
// the linear-Gaussian model (φ and y scaled by √(precision·σn²)). Because the
// feature space changes when an observable is adopted, the model is rebuilt
// from the rows on every revision — O(rows·d²) with rank-one updates — so the
// posterior is always the exact posterior over the current feature space.
//
// The label model (core/hindsight.mjs) is part of the same fold: a pair
// (components at asOf, judgment within two days of asOf) trains it; every
// `rebuildEvery` pairs the hindsight targets are recomputed.
import { Projection, mapToArr, arrToMap } from './projections.mjs';
import { LinearModel, featurize } from './attention.mjs';
import { DAY_MS } from './memory.mjs';
import { makeLabelModel, labelOf, labelPhi, labelPrior } from './hindsight.mjs';
import { bucketOf, programShape } from './observables.mjs';

export const V4_KINDS = ['value.features', 'judgment.recorded', 'hindsight.labeled', 'observable.proposed', 'observable.adopted', 'observable.retired'];

export function makeValueModelV4Projection({ dim = 256, priorVar = 0.005, noiseVar = 0.03, maxRows = 3000, rebuildEvery = 25, labelResidualFloor = 0.09, pairWindowDays = 2, labelMinPairs = 20, stack = true, stackMinTrained = 10, hindsightUse = 'evidence' } = {}) {
  // hindsightUse: 'evidence' — calibrated labels are (weak) evidence for the value model; 'select' — labels only score
  // observable candidates (the future picks the measurements; the operator's judgments alone train the model).
  const init = () => ({
    version: 4, dim, priorVar, noiseVar, maxRows, rebuildEvery, labelResidualFloor, pairWindowDays, labelMinPairs, stack, stackMinTrained, hindsightUse,
    model: new LinearModel({ dim, priorVar, noiseVar, forgetting: 1 }),
    // the stacked head: judgments only, over the same features plus the hindsight model's prediction (weak labels inform, true labels decide)
    modelJ: new LinearModel({ dim, priorVar, noiseVar, forgetting: 1 }), trainedJ: 0,
    features: new Map(), judged: new Map(), pending: new Map(), trained: 0, absErr: 0,
    rows: [], hindN: 0, hindAbsErr: 0, hindRows: 0,
    labelModel: makeLabelModel(), labelPairs: 0, labelAbsErr: 0, comps: new Map(),
    observables: { adopted: new Map(), candidates: new Map(), retired: 0, rev: 0, shapes: new Set() },
    labelledDays: new Set(), pairsSinceRebuild: 0, dirty: false, ig: 0, rebuilds: 0,
  });
  return new Projection({
    name: 'value-model-v4',
    version: 1,
    kinds: V4_KINDS,
    init,
    apply(state, ev) {
      const b = ev.body;
      switch (ev.kind) {
        case 'value.features': {
          if (!b.entityId || !b.features) return;
          const prev = state.features.get(b.entityId);
          if (!prev || (b.ts ?? ev.ts) >= prev.ts) state.features.set(b.entityId, { features: b.features, obs: b.obs ?? null, pluginScore: Number(b.pluginScore) || 0, ts: b.ts ?? ev.ts });
          const j = state.pending.get(b.entityId);
          if (j) { state.pending.delete(b.entityId); trainJudgment(state, b.entityId, j); }
          return;
        }
        case 'judgment.recorded': {
          const id = b.entityId;
          if (!id || !Number.isFinite(Number(b.value))) return;
          const j = { value: Math.max(0, Math.min(1, Number(b.value))), ts: b.ts ?? ev.ts };
          if (state.features.has(id)) trainJudgment(state, id, j); else state.pending.set(id, j);
          const c = state.comps.get(id);
          if (c && Math.abs(c.asOf - j.ts) <= state.pairWindowDays * DAY_MS) trainLabel(state, c.comps, j.value);
          return;
        }
        case 'hindsight.labeled': {
          if (b.empty && Number.isFinite(b.asOfDay)) { state.labelledDays.add(b.asOfDay); return; } // a day with nothing to label is still done
          if (!b.entityId || !b.components || !b.features) return;
          const asOf = Number(b.asOf) || (b.ts ?? ev.ts);
          const prevC = state.comps.get(b.entityId);
          if (!prevC || asOf >= prevC.asOf) state.comps.set(b.entityId, { comps: b.components, asOf });
          const j = state.judged.get(b.entityId) ?? state.pending.get(b.entityId);
          if (j && Math.abs(asOf - j.ts) <= state.pairWindowDays * DAY_MS && !prevC) trainLabel(state, b.components, j.value);
          if (Number.isFinite(b.asOfDay)) state.labelledDays.add(b.asOfDay);
          const row = { id: b.entityId, f: b.features, o: b.obs ?? null, ps: Number(b.pluginScore) || 0, c: b.components, y: null, prec: null, kind: 'hindsight', batch: Number.isFinite(b.asOfDay) ? b.asOfDay : 0, nv: b.novelAt === 0 ? 0 : 1, ts: b.ts ?? ev.ts };
          setHindsightTarget(state, row);
          addRow(state, row);
          return;
        }
        case 'observable.proposed': {
          if (!b.id || !b.program) return;
          if (state.observables.adopted.has(b.id) || state.observables.candidates.has(b.id)) return;
          state.observables.candidates.set(b.id, { id: b.id, program: b.program, type: b.type ?? null, ts: b.ts ?? ev.ts, parent: b.parent ?? null, origin: b.origin ?? null, shape: programShape(b.program) });
          return;
        }
        case 'observable.adopted': {
          if (!b.id || !b.program || !Array.isArray(b.edges)) return;
          if (state.observables.adopted.has(b.id)) return;
          state.observables.candidates.delete(b.id);
          const shape = programShape(b.program);
          state.observables.adopted.set(b.id, { id: b.id, program: b.program, type: b.type ?? null, edges: b.edges, fitness: b.fitness ?? null, n: b.n ?? 0, ts: b.ts ?? ev.ts, shape, newShape: !state.observables.shapes.has(shape) });
          state.observables.shapes.add(shape);
          state.observables.rev++;
          state.dirty = true;
          return;
        }
        case 'observable.retired': {
          if (!b.id) return;
          if (state.observables.candidates.delete(b.id)) { state.observables.retired++; return; }
          if (state.observables.adopted.delete(b.id)) { state.observables.retired++; state.observables.rev++; state.dirty = true; }
          return;
        }
        default: return;
      }
    },
    dehydrate: (s) => ({
      version: s.version, dim: s.dim, priorVar: s.priorVar, noiseVar: s.noiseVar, maxRows: s.maxRows, rebuildEvery: s.rebuildEvery, labelResidualFloor: s.labelResidualFloor, pairWindowDays: s.pairWindowDays, labelMinPairs: s.labelMinPairs, stack: s.stack, stackMinTrained: s.stackMinTrained, hindsightUse: s.hindsightUse ?? 'evidence',
      model: s.model.toState(), modelJ: s.modelJ.toState(), trainedJ: s.trainedJ, features: mapToArr(s.features), judged: mapToArr(s.judged), pending: mapToArr(s.pending), trained: s.trained, absErr: s.absErr,
      rows: s.rows, hindN: s.hindN, hindAbsErr: s.hindAbsErr, hindRows: s.hindRows,
      labelModel: s.labelModel.toState(), labelPairs: s.labelPairs, labelAbsErr: s.labelAbsErr, comps: mapToArr(s.comps),
      observables: { adopted: mapToArr(s.observables.adopted), candidates: mapToArr(s.observables.candidates), retired: s.observables.retired, rev: s.observables.rev, shapes: [...s.observables.shapes] },
      labelledDays: [...s.labelledDays], pairsSinceRebuild: s.pairsSinceRebuild, dirty: s.dirty, ig: s.ig, rebuilds: s.rebuilds,
    }),
    hydrate: (j) => ({
      ...j,
      model: LinearModel.fromState(j.model), modelJ: LinearModel.fromState(j.modelJ), features: arrToMap(j.features), judged: arrToMap(j.judged), pending: arrToMap(j.pending),
      labelModel: LinearModel.fromState(j.labelModel), comps: arrToMap(j.comps),
      observables: { adopted: arrToMap(j.observables.adopted), candidates: arrToMap(j.observables.candidates), retired: j.observables.retired, rev: j.observables.rev, shapes: new Set(j.observables.shapes) },
      labelledDays: new Set(j.labelledDays),
    }),
  });
}

// ---------------------------------------------------------------------------
// Feature space: base features ⊕ adopted observables, bucketed on adoption edges.
// ---------------------------------------------------------------------------
export function phiOf(state, features, obs = null) {
  const adopted = state.observables?.adopted;
  if (!adopted || !adopted.size) return featurize(features, state.model.dim);
  const f = { ...features };
  for (const [id, o] of adopted) f[`obs:${id}`] = bucketOf(obs ? obs[id] : null, o.edges);
  return featurize(f, state.model.dim);
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const HIND_EDGES = [0.1, 0.2, 0.35, 0.5, 0.7];

/** Feature vector of the stacked head: base ⊕ observables ⊕ the hindsight model's prediction (bucketed and linear). */
export function phiStacked(state, features, obs, pluginScore) {
  const phi = phiOf(state, features, obs);
  const h = clamp01(pluginScore + state.model.mean(phi));
  const f = { ...features };
  for (const [id, o] of state.observables?.adopted ?? []) f[`obs:${id}`] = bucketOf(obs ? obs[id] : null, o.edges);
  f[`hind=${bucketOf(h, HIND_EDGES)}`] = 1;
  f.hindLin = h;
  return featurize(f, state.model.dim);
}
/** Is the stacked head the one that scores (enough judgments, stacking on)? */
export const stackedReady = (state) => !!(state.stack && state.modelJ && state.trainedJ >= state.stackMinTrained);

function trainJudgment(state, id, j) {
  const f = state.features.get(id);
  const row = { id, f: f.features, o: f.obs ?? null, ps: f.pluginScore, c: null, y: j.value, prec: 1 / state.noiseVar, kind: 'judgment', batch: Math.floor(j.ts / DAY_MS), ts: j.ts };
  // prequential calibration error BEFORE the update (as in v3), under whichever model scores
  ensureModel(state);
  const phi = phiOf(state, row.f, row.o);
  const pred = stackedReady(state) ? row.ps + state.modelJ.mean(phiStacked(state, row.f, row.o, row.ps)) : row.ps + state.model.mean(phi);
  state.absErr += Math.abs(clamp01(pred) - j.value);
  state.trained++;
  state.judged.set(id, { value: j.value, ts: j.ts });
  addRow(state, row, phi);
  if (state.stack) { state.modelJ.update(phiStacked(state, row.f, row.o, row.ps), j.value - row.ps); state.trainedJ++; }
}

function trainLabel(state, comps, judgment) {
  const phi = labelPhi(comps);
  const pred = labelPrior(comps) + state.labelModel.mean(phi);
  state.labelAbsErr += Math.abs(clamp01(pred) - judgment);
  state.labelModel.update(phi, judgment - labelPrior(comps));
  state.labelPairs++;
  // hindsight rows enter the model only once the label model is calibrated; crossing the bar rebuilds with all of them
  if (state.labelPairs === state.labelMinPairs || ++state.pairsSinceRebuild >= state.rebuildEvery) { state.pairsSinceRebuild = 0; state.dirty = true; }
}

/** Are hindsight labels calibrated enough to be evidence? */
export const labelsReady = (state) => state.labelPairs >= state.labelMinPairs;

export const labelResidualVar = (state) => Math.max(state.labelResidualFloor, state.labelPairs ? (state.labelAbsErr / state.labelPairs) ** 2 : 0.09);

function setHindsightTarget(state, row) {
  const l = labelOf(state.labelModel, row.c, { residualVar: labelResidualVar(state) });
  row.y = l.value;
  row.prec = 1 / l.variance;
}

/** Precision-weighted update: φ and y scaled by √(precision·σn²) ⇒ Λ += prec·φφᵀ, b += prec·φy. */
function updateWeighted(state, phi, target, prec) {
  const s = Math.sqrt(prec * state.noiseVar);
  const scaled = s === 1 ? phi : phi.map(([i, v]) => [i, v * s]);
  const ig = state.model.infoGain(scaled);
  state.model.update(scaled, target * s);
  return ig;
}

function addRow(state, row, phi = null) {
  ensureModel(state);
  state.rows.push(row);
  if (state.rows.length > state.maxRows) state.rows.splice(0, state.rows.length - state.maxRows);
  if (row.kind === 'hindsight') {
    state.hindRows++;
    if (!labelsReady(state)) return; // stored; folded into the model when the label model is calibrated (rebuild)
    phi = phi ?? phiOf(state, row.f, row.o);
    state.hindAbsErr += Math.abs(clamp01(row.ps + state.model.mean(phi)) - row.y);
    state.hindN++;
    if (state.hindsightUse === 'select') return; // a label selects observables; it is not evidence for the model
  }
  phi = phi ?? phiOf(state, row.f, row.o);
  state.ig += updateWeighted(state, phi, row.y - row.ps, row.prec);
}

/** Rebuild the model from the rows under the current feature space (exact; called lazily). */
export function ensureModel(state) {
  if (!state.dirty) return false;
  state.dirty = false;
  state.rebuilds++;
  state.model = new LinearModel({ dim: state.dim, priorVar: state.priorVar, noiseVar: state.noiseVar, forgetting: 1 });
  const ready = labelsReady(state);
  for (const row of state.rows) {
    if (row.kind === 'hindsight') { if (!ready) continue; setHindsightTarget(state, row); if (state.hindsightUse === 'select') continue; }
    updateWeighted(state, phiOf(state, row.f, row.o), row.y - row.ps, row.prec);
  }
  if (state.stack) {
    state.modelJ = new LinearModel({ dim: state.dim, priorVar: state.priorVar, noiseVar: state.noiseVar, forgetting: 1 });
    state.trainedJ = 0;
    for (const row of state.rows) if (row.kind === 'judgment') { state.modelJ.update(phiStacked(state, row.f, row.o, row.ps), row.y - row.ps); state.trainedJ++; }
  }
  return true;
}

/** Information gain accumulated since the last mark (nats); resets the counter. */
export function takeIg(state) { const v = state.ig; state.ig = 0; return v; }

export const hindsightMae = (state) => (state.hindN ? state.hindAbsErr / state.hindN : null);
export const labelMae = (state) => (state.labelPairs ? state.labelAbsErr / state.labelPairs : null);

/** Residual of every row under the current model: [{ obs, r, batch, kind }] (for observable discovery). */
export function residualRows(state) {
  ensureModel(state);
  const out = [];
  const ready = labelsReady(state);
  for (const row of state.rows) {
    if (row.kind === 'hindsight' && !ready) continue;
    const phi = phiOf(state, row.f, row.o);
    out.push({ obs: row.o, r: (row.y - row.ps) - state.model.mean(phi), y: row.y, batch: row.batch, kind: row.kind, id: row.id });
  }
  return out;
}

/** Programs to evaluate for new rows: adopted first, then candidates. */
export function activeObservables(state) {
  return [...state.observables.adopted.values(), ...state.observables.candidates.values()].map((o) => ({ id: o.id, program: o.program, type: o.type }));
}

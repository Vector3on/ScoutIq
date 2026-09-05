// core/valuemodel.mjs — a learned, calibrated value model and active judgment
// selection (v3; replaces the v2 affine calibration when enabled).
//
//   value(x) = clamp( pluginScore(x) + wᵀφ(x) ),   w ~ N(μ, Σ)
//
// The model learns the RESIDUAL between the plug-in's score and operator
// judgments over domain-agnostic entity features (core/features.mjs), with
// the same Bayesian linear machinery as attention (exact posterior, exact
// information gain). Active selection asks the operator to judge the items
// whose judgment would most reduce the model's uncertainty where it matters
// (high IG × decision relevance), not merely the top-k.
//
// Pure fold over value.features (emitted by the worker for candidates it
// shows the operator) and judgment.recorded (existing kind).
import { Projection, mapToArr, arrToMap } from './projections.mjs';
import { LinearModel, featurize } from './attention.mjs';
import { bucketOf } from './observables.mjs';

/** Feature vector for a state: base features, plus adopted observables (v4 states) bucketed on their adoption edges. */
export function phiFor(state, features, obs = null) {
  const adopted = state.observables?.adopted;
  if (!adopted || !adopted.size) return featurize(features, state.model.dim);
  const f = { ...features };
  for (const [id, o] of adopted) f[`obs:${id}`] = bucketOf(obs ? obs[id] : null, o.edges);
  return featurize(f, state.model.dim);
}
const HIND_EDGES = [0.1, 0.2, 0.35, 0.5, 0.7];
const clamp01 = (x) => Math.max(0, Math.min(1, x));
/**
 * The model that scores, and its feature vector. v3 states: the single model. v4 states with a trained stacked head
 * (core/valuemodel-v4.mjs): the judgment-only head over base ⊕ observables ⊕ the hindsight model's prediction.
 */
export function scoringModel(state, features, obs = null, pluginScore = 0) {
  const phi = phiFor(state, features, obs);
  if (!(state.stack && state.modelJ && state.trainedJ >= state.stackMinTrained)) return { model: state.model, phi };
  const h = clamp01(pluginScore + state.model.mean(phi));
  const f = { ...features };
  for (const [id, o] of state.observables?.adopted ?? []) f[`obs:${id}`] = bucketOf(obs ? obs[id] : null, o.edges);
  f[`hind=${bucketOf(h, HIND_EDGES)}`] = 1;
  f.hindLin = h;
  return { model: state.modelJ, phi: featurize(f, state.model.dim), hind: h };
}

export function makeValueModelProjection({ dim = 256, priorVar = 0.25, noiseVar = 0.05, forgetting = 1.0 } = {}) {
  return new Projection({
    name: 'value-model',
    version: 1,
    kinds: ['value.features', 'judgment.recorded'],
    init: () => ({ model: new LinearModel({ dim, priorVar, noiseVar, forgetting }), features: new Map(), judged: new Map(), pending: new Map(), trained: 0, absErr: 0 }),
    apply(state, ev) {
      const b = ev.body;
      if (ev.kind === 'value.features') {
        if (!b.entityId || !b.features) return;
        const prev = state.features.get(b.entityId);
        if (!prev || (b.ts ?? ev.ts) >= prev.ts) state.features.set(b.entityId, { features: b.features, pluginScore: Number(b.pluginScore) || 0, ts: b.ts ?? ev.ts });
        const j = state.pending.get(b.entityId);
        if (j) { state.pending.delete(b.entityId); train(state, b.entityId, j); }
      } else {
        const id = b.entityId;
        if (!id || !Number.isFinite(Number(b.value))) return;
        const j = { value: Math.max(0, Math.min(1, Number(b.value))), ts: b.ts ?? ev.ts };
        if (state.features.has(id)) train(state, id, j); else state.pending.set(id, j);
      }
    },
    dehydrate: (s) => ({ model: s.model.toState(), features: mapToArr(s.features), judged: mapToArr(s.judged), pending: mapToArr(s.pending), trained: s.trained, absErr: s.absErr }),
    hydrate: (j) => ({ model: LinearModel.fromState(j.model), features: arrToMap(j.features), judged: arrToMap(j.judged), pending: arrToMap(j.pending), trained: j.trained, absErr: j.absErr }),
  });
}

function train(state, id, j) {
  const f = state.features.get(id);
  const phi = featurize(f.features, state.model.dim);
  // running calibration error BEFORE the update (a fair, held-out-style measure)
  const pred = Math.max(0, Math.min(1, f.pluginScore + state.model.mean(phi)));
  state.absErr += Math.abs(pred - j.value);
  state.model.update(phi, j.value - f.pluginScore);
  state.judged.set(id, { value: j.value, ts: j.ts });
  state.trained++;
}

/** Predict a calibrated value with uncertainty for an entity's features. */
export function predictValue(state, features, pluginScore, obs = null) {
  const { model, phi } = scoringModel(state, features, obs, pluginScore);
  const mu = model.mean(phi), v = model.variance(phi);
  return { value: Math.max(0, Math.min(1, pluginScore + mu)), residual: mu, sd: Math.sqrt(v), ig: model.infoGain(phi) };
}

/** Mean absolute calibration error so far (prequential). */
export const calibrationMae = (state) => (state.trained ? state.absErr / state.trained : null);

/**
 * Active judgment selection: candidates [{ entityId, features, pluginScore, score, ... }] →
 * the k items whose judgment is worth most.
 *   mode 'ig'  — highest information gain about the model, weighted by relevance.
 *   mode 'ei'  — highest EXPECTED IMPROVEMENT over the delivery cutoff: a judgment reveals
 *                the item's value; E[(v − cutoff)⁺] under the model's predictive N(μ, σ²)
 *                is the expected gain in delivered value from knowing it (Jones et al. 1998).
 *                σ² = posterior variance + a floor for unmodelled error (the running MAE²).
 */
export function selectJudgments(state, candidates, { k = 5, mode = 'ei', cutoff = 0, judgmentSd = 0.15 } = {}) {
  const scored = [];
  const floor = Math.max(0.05, calibrationMae(state) ?? 0.2);
  for (const c of candidates) {
    if (state.judged.has(c.entityId)) continue;
    const { model, phi } = scoringModel(state, c.features, c.obs ?? null, c.pluginScore ?? 0);
    const ig = model.infoGain(phi);
    let priority;
    if (mode === 'ei') {
      const mu = Math.max(0, Math.min(1, (c.pluginScore ?? 0) + model.mean(phi)));
      // knowledge-gradient variance: how much a NOISY judgment can move our estimate (Frazier et al. 2008)
      const varM = model.variance(phi) + floor * floor;
      const sd = varM / Math.sqrt(varM + judgmentSd * judgmentSd);
      priority = expectedImprovement(mu, sd, cutoff);
    } else {
      priority = ig * (0.5 + 0.5 * Math.max(0, Math.min(1, c.score ?? c.pluginScore ?? 0)));
    }
    scored.push({ ...c, ig, priority });
  }
  scored.sort((a, b) => b.priority - a.priority || (a.entityId < b.entityId ? -1 : 1));
  return scored.slice(0, k);
}

export function expectedImprovement(mu, sd, cutoff) {
  if (sd <= 1e-9) return Math.max(0, mu - cutoff);
  const z = (mu - cutoff) / sd;
  const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const cdf = 0.5 * (1 + erf(z / Math.SQRT2));
  return sd * pdf + (mu - cutoff) * cdf;
}
function erf(x) {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

/**
 * Combine the model's estimate with a judgment as two noisy observations of the same value
 * (precision-weighted). A judgment is evidence, not ground truth: this is what stops a large
 * budget of noisy judgments on marginal items from delivering the winner's curse.
 */
export function posteriorValue(state, features, pluginScore, judgment, { judgmentSd = 0.15, obs = null } = {}) {
  const p = predictValue(state, features, pluginScore, obs);
  const floor = Math.max(0.05, calibrationMae(state) ?? 0.2);
  const varM = p.sd * p.sd + floor * floor, varJ = judgmentSd * judgmentSd;
  const value = (p.value / varM + judgment / varJ) / (1 / varM + 1 / varJ);
  return { value: Math.max(0, Math.min(1, value)), sd: Math.sqrt(1 / (1 / varM + 1 / varJ)) };
}

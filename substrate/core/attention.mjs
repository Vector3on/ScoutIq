// core/attention.mjs — the attention allocator.
//
// A Bayesian linear model over hashed action features:
//   y = wᵀφ(a) + ε,  w ~ N(0, σ0² I),  ε ~ N(0, σn²)
// with sufficient statistics (Λ, b) kept in the log's planner projection:
//   Λ = I/σ0² + Σ φφᵀ/σn²,  b = Σ φ y/σn²,  Σ = Λ⁻¹,  μ = Σ b.
// Pragmatic value  E[y|a] = μᵀφ(a).
// Epistemic value  IG(a) = ½ log(1 + φᵀΣφ/σn²)  — the exact expected reduction
//   in posterior entropy of w from observing y(a) (Chaloner & Verdinelli 1995).
// Selection: one Thompson sample w̃ ~ N(μ, Σ) per run (Agrawal & Goyal 2013),
//   score(a) = w̃ᵀφ(a) + β·IG(a), greedy knapsack by score/cost under the
//   run's time budget. Non-stationarity: exponential forgetting anchored to
//   the prior so uncertainty regrows and stale beliefs get re-tested.
// This is the bounded-rational reduction of expected free energy for a
// linear-Gaussian generative model (see DESIGN.md §4.3 for the derivation).
import { fnv1a } from './embed.mjs';

export function cholesky(A, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (s <= 1e-12) s = 1e-12; // jitter for numerical safety
        L[i * n + i] = Math.sqrt(s);
      } else {
        L[i * n + j] = s / L[j * n + j];
      }
    }
  }
  return L;
}

/** Solve (L Lᵀ) x = b. */
export function choleskySolve(L, n, b) {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

export function featurize(features, dim) {
  const out = [[0, 1]]; // bias
  const seen = new Map();
  for (const [k, v] of Object.entries(features ?? {})) {
    if (v === null || v === undefined) continue;
    const name = typeof v === 'number' ? `${k}` : `${k}=${v}`;
    const weight = typeof v === 'number' ? v : 1;
    const h = fnv1a(name);
    const idx = 1 + (h % (dim - 1));
    const sign = fnv1a(name, 0x9747b28c) & 1 ? 1 : -1;
    seen.set(idx, (seen.get(idx) ?? 0) + sign * weight);
  }
  for (const [i, w] of seen) if (w !== 0) out.push([i, w]);
  return out;
}

export function bucket(x, edges) {
  let i = 0;
  while (i < edges.length && x >= edges[i]) i++;
  return `b${i}`;
}

export class LinearModel {
  constructor({ dim = 128, priorVar = 1.0, noiseVar = 0.25, forgetting = 0.98 } = {}) {
    this.dim = dim;
    this.priorVar = priorVar;
    this.noiseVar = noiseVar;
    this.forgetting = forgetting;
    this.L = new Float64Array(dim * dim); // Λ (precision)
    this.b = new Float64Array(dim);
    for (let i = 0; i < dim; i++) this.L[i * dim + i] = 1 / priorVar;
    this.n = 0;
    this._post = null;
  }
  static fromState(s) {
    const m = new LinearModel({ dim: s.dim, priorVar: s.priorVar, noiseVar: s.noiseVar, forgetting: s.forgetting });
    m.L = Float64Array.from(s.L);
    m.b = Float64Array.from(s.b);
    m.n = s.n;
    return m;
  }
  toState() {
    return { dim: this.dim, priorVar: this.priorVar, noiseVar: this.noiseVar, forgetting: this.forgetting, L: Array.from(this.L), b: Array.from(this.b), n: this.n };
  }
  update(phi, y) {
    const d = this.dim, inv = 1 / this.noiseVar;
    for (const [i, vi] of phi) {
      this.b[i] += vi * y * inv;
      for (const [j, vj] of phi) this.L[i * d + j] += vi * vj * inv;
    }
    this.n++;
    this._post = null;
  }
  forget() {
    const g = this.forgetting, d = this.dim, p0 = 1 / this.priorVar;
    for (let i = 0; i < d * d; i++) this.L[i] *= g;
    for (let i = 0; i < d; i++) this.L[i * d + i] += (1 - g) * p0;
    for (let i = 0; i < d; i++) this.b[i] *= g;
    this._post = null;
  }
  posterior() {
    if (this._post) return this._post;
    const d = this.dim;
    const chol = cholesky(this.L, d);
    const mu = choleskySolve(chol, d, this.b);
    // Σ = Λ⁻¹ column by column
    const Sigma = new Float64Array(d * d);
    const e = new Float64Array(d);
    for (let j = 0; j < d; j++) {
      e.fill(0); e[j] = 1;
      const col = choleskySolve(chol, d, e);
      for (let i = 0; i < d; i++) Sigma[i * d + j] = col[i];
    }
    this._post = { mu, Sigma, cholSigma: null };
    return this._post;
  }
  mean(phi) { const { mu } = this.posterior(); let s = 0; for (const [i, v] of phi) s += mu[i] * v; return s; }
  variance(phi) {
    const { Sigma } = this.posterior(); const d = this.dim; let s = 0;
    for (const [i, vi] of phi) for (const [j, vj] of phi) s += vi * vj * Sigma[i * d + j];
    return Math.max(0, s);
  }
  infoGain(phi) { return 0.5 * Math.log(1 + this.variance(phi) / this.noiseVar); }
  sample(rng) {
    const post = this.posterior();
    const d = this.dim;
    if (!post.cholSigma) post.cholSigma = cholesky(post.Sigma, d);
    const z = new Float64Array(d);
    for (let i = 0; i < d; i++) z[i] = rng.gauss();
    const w = Float64Array.from(post.mu);
    for (let i = 0; i < d; i++) { let s = 0; for (let k = 0; k <= i; k++) s += post.cholSigma[i * d + k] * z[k]; w[i] += s; }
    return w;
  }
}

export const dot = (w, phi) => { let s = 0; for (const [i, v] of phi) s += w[i] * v; return s; };

/**
 * Budgeted selection. candidates: [{ id, features, cost (sec), ... }].
 * Returns the chosen candidates in execution order with their scores.
 */
export function selectActions(candidates, { model, rng, beta = 0.3, budget, minCost = 0.05, sampled = null, reserve = [] }) {
  const w = sampled ?? model.sample(rng);
  const scored = candidates.map((c) => {
    const phi = featurize(c.features, model.dim);
    const exploit = dot(w, phi);
    const ig = model.infoGain(phi);
    const mean = model.mean(phi);
    const score = exploit + beta * ig;
    const cost = Math.max(minCost, c.cost ?? 1);
    return { ...c, phi, score, exploit, ig, mean, cost, ratio: score / cost };
  });
  // Order: positive scores by value density, then the rest by score (least bad first).
  const order = (arr) => [...arr.filter((s) => s.score > 0).sort((a, b) => b.ratio - a.ratio), ...arr.filter((s) => s.score <= 0).sort((a, b) => b.score - a.score)];
  const chosen = [];
  const taken = new Set();
  let used = 0;
  // Complementarity reserve: the pipeline's outputs need every stage (sense AND
  // think), which an additive knapsack objective cannot express; each group is
  // guaranteed a fraction of the budget before the free-for-all allocation.
  for (const r of reserve) {
    const group = order(scored.filter((s) => r.match(s)));
    let groupUsed = 0;
    const cap = budget * r.fraction;
    for (const s of group) {
      if (groupUsed + s.cost <= cap && used + s.cost <= budget) { chosen.push(s); taken.add(s.id); used += s.cost; groupUsed += s.cost; }
    }
  }
  for (const s of order(scored.filter((s) => !taken.has(s.id)))) {
    if (used + s.cost <= budget) { chosen.push(s); taken.add(s.id); used += s.cost; }
  }
  if (!chosen.length && scored.length) {
    const cheapest = scored.slice().sort((a, b) => a.cost - b.cost)[0];
    chosen.push(cheapest);
    used = cheapest.cost;
  }
  return { chosen, used, scored };
}

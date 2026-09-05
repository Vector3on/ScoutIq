// core/hindsight.mjs — the memory labels its own past with its own future (v4).
//
// v3 showed the remaining ceiling on the toy is an information limit, and
// that the one lever still responding was the operator's judgments — ten per
// heartbeat, each revealing item-level truth. This module makes labels cheap:
// an entity observed at time t is a PRECURSOR if the structures it belonged
// to grew afterwards — the pair of neighbours it bridged became a busy pair,
// the neighbour it linked became more active, its rare vocabulary became
// common, its own signals rose. Every component is schema-generic and is
// computed from the current memory's timestamps alone (relations carry
// firstSeen, series carry time, term bursts carry days), so no snapshot of
// the past is needed: the memory projection is already a temporal database.
//
// The components are not the label. A tiny label model — a Bayesian linear
// regression from components to operator judgments, trained on entities that
// have both — turns them into a calibrated value with a variance, so a
// hindsight label is evidence of known (lower) precision next to a judgment.
// The value model (core/valuemodel.mjs, v4 projection) folds thousands of
// such labels per run where it previously saw ten judgments.
import { DAY_MS, neighbors, relationRecord } from './memory.mjs';
import { tokenize } from './embed.mjs';
import { LinearModel, featurize } from './attention.mjs';

const MAX_NBR = 8;

/**
 * Hindsight burst statistic for counts (Kleinberg in reverse): how surprising the
 * future count is under the rate the past implied, with `pseudoDays` of prior
 * history so a brand-new structure is not credited with an infinite rate.
 *   expected = horizon · (before + 0.5) / max(ageDays + 1, pseudoDays)
 *   z        = (after − expected) / √(expected + 1)
 * squashed to [0,1): 1 − exp(−z/2) for z > 0, else 0.
 */
export function burstZ(before, after, ageDays, horizon, { pseudoDays = 7 } = {}) {
  // the past rate: unbiased for structures older than pseudoDays, shrunk toward zero for younger ones
  const expected = horizon * (before + 0.5) / Math.max(Math.max(0, ageDays) + 1, pseudoDays);
  const z = (after - expected) / Math.sqrt(expected + 1);
  return z > 0 ? 1 - Math.exp(-z / 2) : 0;
}
/**
 * "Young and growing": the structure this entity belongs to was born recently (age at asOf, discounted over the
 * horizon) and becomes substantial by the end of the horizon (total count, saturating at `scale`). This is the
 * hindsight form of an emerging bridge or a newcomer: not surprise relative to yesterday, but membership in a
 * nascent structure that the future confirms.
 */
export function youngGrowth(total, ageDays, horizon, { scale = 8 } = {}) {
  if (!(total > 0)) return 0;
  return Math.exp(-Math.max(0, ageDays) / horizon) * (1 - Math.exp(-total / scale));
}
/** Mean shift of a series between the window before asOf and the window after, relative to its level. */
export function meanShift(points, asOf, end, { window }) {
  let sb = 0, nb = 0, sa = 0, na = 0;
  for (const [t, v] of points) {
    if (t <= asOf && t > asOf - window) { sb += v; nb++; }
    else if (t > asOf && t <= end) { sa += v; na++; }
  }
  if (!nb || !na) return null;
  const before = sb / nb, after = sa / na;
  const g = (after - before) / (Math.abs(before) + 1);
  return g > 0 ? 1 - Math.exp(-g * 2) : 0;
}

/**
 * Growth components of entity `id` between `asOf` and `asOf + horizon`, read
 * from `memory` (the memory NOW, which must extend past asOf + horizon).
 * Returns { name: value ∈ [0,1] }. Names are schema-derived so the label
 * model can weight them.
 */
export function hindsightComponents(id, { memory, asOf, horizon, schema }) {
  const e = memory.entities.get(id);
  if (!e) return null;
  const end = asOf + horizon * DAY_MS;
  const comps = {};
  const rels = schema.relations.filter((r) => r.from === e.type || r.to === e.type);
  const edgeRec = (x, rel, dir, n) => (dir === 'out' ? relationRecord(memory, x, rel, n) : relationRecord(memory, n, rel, x));
  // neighbours as of asOf (edges that existed then), per relation
  const nbrAt = new Map();
  for (const r of rels) {
    const dir = r.from === e.type ? 'out' : 'in';
    const list = [];
    for (const n of neighbors(memory, id, r.rel, dir)) { const rec = edgeRec(id, r.rel, dir, n); if (rec && rec.firstSeen <= asOf) list.push(n); if (list.length >= MAX_NBR) break; }
    nbrAt.set(r.rel, { dir, list, nType: dir === 'out' ? r.to : r.from });
  }
  // 1. pair bursts: entities of my type linked to both neighbours — how surprising the next `horizon` days are under the pair's past rate
  for (let i = 0; i < rels.length; i++) for (let j = i; j < rels.length; j++) {
    const A = nbrAt.get(rels[i].rel), B = nbrAt.get(rels[j].rel);
    let best = null, bestYoung = null;
    for (const a of A.list) for (const b of B.list) {
      if (a === b) continue;
      if (i === j && a > b) continue;
      const { before, after, first } = coCounts(memory, a, rels[i].rel, A.dir, b, rels[j].rel, B.dir, asOf, end);
      const age = before ? Math.max(0, asOf - first) / DAY_MS : 0;
      const z = burstZ(before, after - before, age, horizon);
      if (best === null || z > best) best = z;
      // a structure that predates memory has an unknown age: it is not young (habitual pairs are old, whatever memory saw first)
      const y = before && first <= memory.minT + DAY_MS ? 0 : youngGrowth(after, age, horizon);
      if (bestYoung === null || y > bestYoung) bestYoung = y;
    }
    if (best !== null) { comps[`pair:${rels[i].rel}×${rels[j].rel}`] = best; comps[`young:${rels[i].rel}×${rels[j].rel}`] = bestYoung; }
  }
  // 2. neighbour signal shifts and 3. neighbour degree bursts
  for (const r of rels) {
    const { dir, list, nType } = nbrAt.get(r.rel);
    if (!list.length) continue;
    for (const s of schema.signals) {
      if (s.type && s.type !== nType) continue;
      let best = null;
      for (const n of list) {
        const ser = memory.entities.get(n)?.signals.get(s.name);
        if (!ser) continue;
        const g = meanShift(ser.points, asOf, end, { window: horizon * DAY_MS });
        if (g !== null && (best === null || g > best)) best = g;
      }
      if (best !== null) comps[`sig:${r.rel}:${s.name}`] = best;
    }
    let bestDeg = null;
    for (const n of list) {
      const { before, after, first } = degreeCounts(memory, n, r.rel, dir === 'out' ? 'in' : 'out', asOf, end);
      const z = burstZ(before, after - before, before ? Math.max(0, asOf - first) / DAY_MS : 0, horizon);
      if (bestDeg === null || z > bestDeg) bestDeg = z;
    }
    if (bestDeg !== null) comps[`deg:${r.rel}`] = bestDeg;
  }
  // 4. vocabulary: a token that was rare and became common (the same statistic over term days)
  if (e.text) {
    const asOfDay = Math.floor(asOf / DAY_MS), endDay = Math.floor(end / DAY_MS);
    let best = 0, bestYoung = 0;
    for (const tok of new Set(tokenize(e.text))) {
      const b = memory.terms.burst.get(tok), df = memory.terms.df.get(tok) ?? 0;
      if (!b || df < 3) continue;
      let after = 0, tail = 0;
      for (const [d, c] of b.days) { if (d > asOfDay && d <= endDay) after += c; if (d > endDay) tail += c; }
      const before = Math.max(0, df - after - tail);
      const z = burstZ(before, after, asOfDay - b.first, endDay - asOfDay);
      if (z > best) best = z;
      const y = b.first <= Math.floor(memory.minT / DAY_MS) + 1 ? 0 : youngGrowth(before + after, asOfDay - b.first, horizon);
      if (y > bestYoung) bestYoung = y;
    }
    comps.term = best;
    comps['young:term'] = bestYoung;
  }
  // 5. self growth: own degree burst and own signal shifts
  {
    let before = 0, after = 0, first = Infinity;
    for (const r of rels) {
      const dir = r.from === e.type ? 'out' : 'in';
      for (const n of neighbors(memory, id, r.rel, dir)) { const rec = edgeRec(id, r.rel, dir, n); if (!rec) continue; if (rec.firstSeen <= asOf) { before++; if (rec.firstSeen < first) first = rec.firstSeen; } if (rec.firstSeen <= end) after++; }
    }
    comps['self:deg'] = burstZ(before, after - before, before ? Math.max(0, asOf - first) / DAY_MS : 0, horizon);
    for (const s of schema.signals) {
      if (s.type && s.type !== e.type) continue;
      const ser = e.signals.get(s.name);
      if (!ser) continue;
      const g = meanShift(ser.points, asOf, end, { window: horizon * DAY_MS });
      if (g !== null) comps[`self:sig:${s.name}`] = g;
    }
  }
  return comps;
}

function coCounts(memory, a, relA, dirA, b, relB, dirB, asOf, end) {
  const backA = dirA === 'out' ? 'in' : 'out', backB = dirB === 'out' ? 'in' : 'out';
  const A = neighbors(memory, a, relA, backA), B = neighbors(memory, b, relB, backB);
  const [small, large] = A.size < B.size ? [A, B] : [B, A];
  let before = 0, after = 0, first = Infinity;
  for (const x of small) {
    if (!large.has(x)) continue;
    const ra = backA === 'in' ? relationRecord(memory, x, relA, a) : relationRecord(memory, a, relA, x);
    const rb = backB === 'in' ? relationRecord(memory, x, relB, b) : relationRecord(memory, b, relB, x);
    const t = Math.max(ra?.firstSeen ?? 0, rb?.firstSeen ?? 0);
    if (t <= asOf) { before++; if (t < first) first = t; }
    if (t <= end) after++;
  }
  return { before, after, first };
}

function degreeCounts(memory, n, rel, dir, asOf, end) {
  let before = 0, after = 0, first = Infinity;
  for (const x of neighbors(memory, n, rel, dir)) {
    const rec = dir === 'out' ? relationRecord(memory, n, rel, x) : relationRecord(memory, x, rel, n);
    if (!rec) continue;
    if (rec.firstSeen <= asOf) { before++; if (rec.firstSeen < first) first = rec.firstSeen; }
    if (rec.firstSeen <= end) after++;
  }
  return { before, after, first };
}

// ---------------------------------------------------------------------------
// The label model: components → value, calibrated by judgments.
//   label = wᵀφ(c),  φ = bucketed component indicators ⊕ the raw components
// Piecewise-constant in each component: with a hundred judgment pairs it
// recovers the thresholds ("a very young, large pair is worth a lot") that a
// linear fit over the same pairs cannot (measured: ρ with hidden truth 0.39
// vs 0.19 on the toy). Predictive variance + residual variance give the
// label's precision as evidence for the value model.
// ---------------------------------------------------------------------------
export const LABEL_DIM = 128;
const LABEL_EDGES = [0.1, 0.3, 0.5, 0.7, 0.85];
export const labelPrior = () => 0;
export function labelPhi(comps) {
  const f = {};
  for (const [k, v] of Object.entries(comps ?? {})) {
    if (!Number.isFinite(v)) continue;
    let i = 0;
    while (i < LABEL_EDGES.length && v >= LABEL_EDGES[i]) i++;
    f[`${k}=b${i}`] = 1;
    f[k] = v;
  }
  return featurize(f, LABEL_DIM);
}

export function makeLabelModel({ priorVar = 0.05, noiseVar = 0.04 } = {}) {
  return new LinearModel({ dim: LABEL_DIM, priorVar, noiseVar, forgetting: 1 });
}

/** Label with precision for a components vector. `residualVar` is the running |label − judgment|² on judged pairs. */
export function labelOf(model, comps, { residualVar = 0.09 } = {}) {
  const phi = labelPhi(comps);
  const mu = labelPrior(comps) + model.mean(phi);
  const variance = model.variance(phi) + residualVar;
  return { value: Math.max(0, Math.min(1, mu)), variance };
}

/** Rank correlation (for reports and the harness). */
export function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); idx.forEach(([, i], k) => { r[i] = k; }); return r; };
  const rx = rank(xs), ry = rank(ys), m = (n - 1) / 2;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (rx[i] - m) * (ry[i] - m); sxx += (rx[i] - m) ** 2; syy += (ry[i] - m) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

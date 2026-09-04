// core/embed.mjs — dependency-free text features.
//
// HashEmbedder: feature-hashed unigram+bigram vectors (Weinberger et al. 2009),
// sublinear tf, optional IDF weighting from the substrate's own term
// statistics, L2-normalized. Deterministic, fast, no model download. Good
// enough for near-duplicate detection and semantic-spread descriptors; an
// external embedder (Ollama/Colab) can replace it via `entity.embedded` events.
const STOP = new Set(('a an and are as at be but by for from has have if in into is it its of on or that the this to was were will with we our you your they their not no nor can could should would may might also than then there these those which who whom whose what when where why how all any both each few more most other some such only own same so too very s t just do does did done doing about above after again against before below between during over under up down out off once here further while because until through via using use used based new'.split(' ')));

export function tokenize(text, { stop = true, minLen = 2, maxLen = 30 } = {}) {
  if (!text) return [];
  const norm = String(text).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const out = [];
  for (const tok of norm.split(/[^a-z0-9]+/)) {
    if (tok.length < minLen || tok.length > maxLen) continue;
    if (/^\d+$/.test(tok)) continue;
    if (stop && STOP.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

export function fnv1a(str, seed = 2166136261) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export class HashEmbedder {
  constructor({ dim = 256, bigrams = true } = {}) {
    this.dim = dim;
    this.bigrams = bigrams;
    this.name = `hash-v1-${dim}`;
  }
  /** idf: optional function token → weight (default 1). */
  embed(text, idf = null) {
    const toks = tokenize(text);
    const counts = new Map();
    const bump = (f, w) => counts.set(f, (counts.get(f) ?? 0) + w);
    for (let i = 0; i < toks.length; i++) {
      bump(toks[i], idf ? idf(toks[i]) : 1);
      if (this.bigrams && i + 1 < toks.length) bump(`${toks[i]}_${toks[i + 1]}`, 0.5 * (idf ? Math.max(idf(toks[i]), idf(toks[i + 1])) : 1));
    }
    const v = new Float32Array(this.dim);
    for (const [f, c] of counts) {
      const h = fnv1a(f);
      const idx = h % this.dim;
      const sign = fnv1a(f, 0x9747b28c) & 1 ? 1 : -1;
      v[idx] += sign * Math.log1p(c);
    }
    return normalize(v);
  }
}

export function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  if (s === 0) return v;
  const inv = 1 / Math.sqrt(s);
  for (let i = 0; i < v.length; i++) v[i] *= inv;
  return v;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return Math.max(-1, Math.min(1, s));
}

export function centroid(vectors, dim) {
  const c = new Float32Array(dim);
  let n = 0;
  for (const v of vectors) {
    if (!v) continue;
    for (let i = 0; i < dim; i++) c[i] += v[i];
    n++;
  }
  if (n === 0) return null;
  return normalize(c);
}

/** Mean pairwise cosine distance (0 = identical, 1 = orthogonal), capped sample. */
export function spread(vectors, maxPairs = 400) {
  const vs = vectors.filter(Boolean);
  if (vs.length < 2) return 0;
  let sum = 0, n = 0;
  for (let i = 0; i < vs.length && n < maxPairs; i++) {
    for (let j = i + 1; j < vs.length && n < maxPairs; j++) {
      sum += 1 - cosine(vs[i], vs[j]);
      n++;
    }
  }
  return n ? Math.max(0, Math.min(1, sum / n)) : 0;
}

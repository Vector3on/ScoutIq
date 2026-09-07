// core/events.mjs — event primitives for the Loam substrate.
//
// Invariants enforced here:
//   E1. Canonical JSON: the same value always serializes to the same bytes
//       (sorted keys, no undefined, finite numbers only).
//   E2. Content-addressed ids: an event's id is the hash of its canonical form,
//       so the same event inserted twice is the same row (idempotent union).
//   E3. Hybrid logical clocks: every event carries an HLC string that sorts
//       lexicographically in causal order across nodes (wall, logical, node).
//   E4. No wall-clock reads inside pure code: only `Clock` touches Date.now().
import { createHash, randomBytes } from 'node:crypto';

/** Canonical JSON: sorted keys, drops undefined, rejects non-finite numbers. */
export function canonicalize(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : sortValue(x)));
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError('canonicalize: non-finite number');
    return v;
  }
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined) continue;
      out[k] = sortValue(v[k]);
    }
    return out;
  }
  return v;
}

export function sha256hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/** Short stable hash used for ids and dedup keys (128 bits of SHA-256). */
export function shortHash(input) {
  return sha256hex(typeof input === 'string' ? input : canonicalize(input)).slice(0, 32);
}

// ---------------------------------------------------------------------------
// Hybrid logical clock (Kulkarni et al. 2014).
// Serialized as `${wall hex 12}-${logical hex 4}-${node}` so string order equals
// (wall, logical, node) order, and events from one node are strictly increasing.
// ---------------------------------------------------------------------------
export class Clock {
  constructor(node, now = () => Date.now()) {
    if (!node || /[^a-zA-Z0-9._:-]/.test(node)) throw new TypeError(`Clock: bad node id ${node}`);
    this.node = node;
    this.now = now;
    this.wall = 0;
    this.logical = 0;
  }
  /** Produce a new HLC for a local event. */
  tick() {
    const now = Math.max(0, Math.floor(this.now()));
    if (now > this.wall) {
      this.wall = now;
      this.logical = 0;
    } else {
      this.logical += 1;
    }
    return encodeHlc(this.wall, this.logical, this.node);
  }
  /** Observe a remote HLC (on sync) so future local ticks sort after it. */
  observe(hlc) {
    const { wall, logical } = decodeHlc(hlc);
    const now = Math.max(0, Math.floor(this.now()));
    const maxWall = Math.max(this.wall, wall, now);
    if (maxWall === this.wall && maxWall === wall) this.logical = Math.max(this.logical, logical) + 1;
    else if (maxWall === this.wall) this.logical += 1;
    else if (maxWall === wall) this.logical = logical + 1;
    else this.logical = 0;
    this.wall = maxWall;
  }
}

export function encodeHlc(wall, logical, node) {
  return `${wall.toString(16).padStart(12, '0')}-${logical.toString(16).padStart(4, '0')}-${node}`;
}

export function decodeHlc(hlc) {
  const m = /^([0-9a-f]{12})-([0-9a-f]{4})-(.+)$/.exec(hlc);
  if (!m) throw new TypeError(`bad hlc: ${hlc}`);
  return { wall: parseInt(m[1], 16), logical: parseInt(m[2], 16), node: m[3] };
}

export function hlcWall(hlc) {
  return parseInt(hlc.slice(0, 12), 16);
}

export function compareHlc(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Event construction.
// ---------------------------------------------------------------------------
export const KINDS = Object.freeze([
  'run.started', 'run.completed',
  'observation.seen',
  'entity.embedded',
  'source.polled', 'source.blocked', 'robots.fetched',
  'policy.denied', 'policy.warning', 'policy.redacted',
  'action.planned', 'action.outcome', 'task.claimed',
  'strategy.evaluated', 'strategy.seeded',
  'finding.emitted',
  'judgment.recorded', 'note.recorded',
  'proposal.created', 'proposal.approved', 'proposal.rejected', 'proposal.executed',
  'plugin.loaded',
  // v3 additive kinds (DESIGN.md §9): none of the v2 projections fold these.
  'strategy.phenotype',
  'challenge.created', 'challenge.evaluated', 'challenge.retired',
  'value.features', 'judgment.requested',
  'credit.assigned',
  'sentinel.intervened',
  // v4 additive kinds (DESIGN.md §10): hindsight labels, learned observables, retrospective environments reuse challenge.*
  'hindsight.labeled',
  'observable.proposed', 'observable.adopted', 'observable.retired',
]);
const KIND_SET = new Set(KINDS);

/**
 * Build an immutable event. `body` must already be sanitized by the policy
 * layer (the store enforces this via `meta.sanitized`).
 */
export function makeEvent({ node, seq, hlc, kind, ts, body, dedupKey = null, domain = null }) {
  if (!KIND_SET.has(kind)) throw new TypeError(`unknown event kind: ${kind}`);
  if (!Number.isInteger(seq) || seq < 1) throw new TypeError('seq must be a positive integer');
  if (typeof hlc !== 'string') throw new TypeError('hlc required');
  const core = { node, seq, hlc, kind, ts, body: sortValue(body), dedupKey, domain };
  const id = shortHash(canonicalize(core));
  return deepFreeze({ id, ...core });
}

export function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

export function newNodeId(role = 'worker') {
  const host = (process.env.LOAM_NODE_NAME || process.env.HOSTNAME || 'local').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 24) || 'local';
  return `${role}.${host}.${randomBytes(3).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (splitmix32-based). All stochastic core code takes an
// explicit RNG so runs are reproducible from a seed. Never Math.random().
// ---------------------------------------------------------------------------
export function makeRng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : hashSeed(String(seed));
  const rng = function next() {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    return (t >>> 0) / 4294967296;
  };
  rng.int = (n) => Math.floor(rng() * n);
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.gauss = () => {
    // Box–Muller
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  };
  rng.shuffle = (arr) => {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  rng.fork = (label) => makeRng(hashSeed(`${a}:${label}`));
  return rng;
}

function hashSeed(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// core/projections.mjs — pure folds over the HLC-sorted event set, with
// snapshot acceleration that is exact: a snapshot is reused only if every
// event that arrived after it sorts after its watermark; otherwise we replay.
import { compareHlc } from './events.mjs';

export class Projection {
  constructor({ name, version = 1, init, apply, dehydrate = (s) => s, hydrate = (j) => j, kinds = null }) {
    this.name = name;
    this.version = version;
    this.init = init;
    this.apply = apply;
    this.dehydrate = dehydrate;
    this.hydrate = hydrate;
    this.kinds = kinds ? new Set(kinds) : null;
  }
  accepts(ev, domain) {
    if (this.kinds && !this.kinds.has(ev.kind)) return false;
    if (domain !== undefined && ev.domain !== null && ev.domain !== domain) return false;
    return true;
  }
}

/** Fold a list of events (any order) into a fresh state. */
export function foldEvents(projection, events, { domain } = {}) {
  const state = projection.init();
  const sorted = events.filter((e) => projection.accepts(e, domain)).sort((a, b) => compareHlc(a.hlc, b.hlc));
  let watermark = '';
  for (const ev of sorted) {
    projection.apply(state, ev);
    watermark = ev.hlc;
  }
  return { state, watermark };
}

/**
 * Build a projection's state from a store, using and refreshing snapshots.
 * Returns { state, watermark, ingestSeq, replayed, applied }.
 */
export async function project(store, projection, { domain, useSnapshot = true, saveSnapshot = true, log = () => {}, batch = 2000 } = {}) {
  const snapName = `${projection.name}:${domain ?? '*'}`;
  let state = null, watermark = '', cursor = 0, replayed = false;
  const snap = useSnapshot ? await store.getSnapshot(snapName) : null;
  if (snap && snap.version === projection.version) {
    state = projection.hydrate(snap.state);
    watermark = snap.watermark;
    cursor = snap.ingestSeq;
  } else {
    state = projection.init();
  }
  // Read everything after the cursor.
  const fresh = [];
  let c = cursor;
  for (;;) {
    const rows = await store.readSince(c, batch);
    if (!rows.length) break;
    for (const r of rows) if (projection.accepts(r, domain)) fresh.push(r);
    c = rows[rows.length - 1].ingestSeq;
    if (rows.length < batch) break;
  }
  const lastIngest = c;
  const outOfOrder = watermark && fresh.some((e) => compareHlc(e.hlc, watermark) < 0);
  if (outOfOrder) {
    // Late arrival with an earlier clock: replay from scratch to stay exact.
    replayed = true;
    log(`${snapName}: out-of-order arrival; replaying from scratch`);
    state = projection.init();
    watermark = '';
    const all = [];
    let cc = 0;
    for (;;) {
      const rows = await store.readSince(cc, batch);
      if (!rows.length) break;
      for (const r of rows) if (projection.accepts(r, domain)) all.push(r);
      cc = rows[rows.length - 1].ingestSeq;
      if (rows.length < batch) break;
    }
    all.sort((a, b) => compareHlc(a.hlc, b.hlc));
    for (const ev of all) { projection.apply(state, ev); watermark = ev.hlc; }
  } else {
    fresh.sort((a, b) => compareHlc(a.hlc, b.hlc));
    for (const ev of fresh) { projection.apply(state, ev); watermark = ev.hlc; }
  }
  if (saveSnapshot && (fresh.length || replayed)) {
    await store.putSnapshot({ name: snapName, version: projection.version, watermark, ingestSeq: lastIngest, state: projection.dehydrate(state), builtAt: Date.now() });
  }
  return { state, watermark, ingestSeq: lastIngest, replayed, applied: fresh.length };
}

/** Apply one freshly appended local event to an already-built state (same fold). */
export function applyLive(projection, state, ev, { domain } = {}) {
  if (projection.accepts(ev, domain)) projection.apply(state, ev);
}

// Small (de)hydration helpers shared by projections.
export const mapToArr = (m, f = (v) => v) => [...m.entries()].map(([k, v]) => [k, f(v)]);
export const arrToMap = (a, f = (v) => v) => new Map((a ?? []).map(([k, v]) => [k, f(v)]));
export const setToArr = (s) => [...s];
export const arrToSet = (a) => new Set(a ?? []);

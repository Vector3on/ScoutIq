// core/timetravel.mjs — memory as it was (v4).
//
// The log is append-only and every observation carries its own time, so the
// memory of any past heartbeat is a fold of the events that existed then.
// This is what makes hindsight possible: the substrate can re-see what it saw
// at run R' and compare it with what it knows now. Nothing here is new state —
// a time-travelled memory is a pure function of the log and a cutoff.
import { memoryProjection } from './memory.mjs';
import { foldEvents } from './projections.mjs';

/** Past heartbeats of a domain, oldest first: [{ runId, now, ts, day }]. */
export async function pastRuns(store, domain, { epoch = 0, dayMs = 86400000 } = {}) {
  const evs = await store.readAll({ domain, kinds: ['run.completed'] });
  return evs.map((e) => e.body).filter((b) => b.domain === domain && Number.isFinite(b.startedAt))
    .map((b) => ({ runId: b.runId, now: b.startedAt, ts: b.startedAt + (b.elapsedMs ?? 0), day: Math.floor((b.startedAt - epoch) / dayMs) }))
    .sort((a, b) => a.now - b.now);
}

/**
 * Memory as of a cutoff: the fold of observation events whose log time is
 * ≤ cutoffTs (the time a past heartbeat finished). `events` may be passed in
 * to avoid re-reading the store when several cutoffs are folded in one run.
 */
export async function memoryAsOf(store, { domain, cutoffTs, events = null }) {
  const all = events ?? await store.readAll({ domain, kinds: ['observation.seen', 'entity.embedded'] });
  const upTo = all.filter((e) => e.ts <= cutoffTs);
  const state = foldEvents(memoryProjection, upTo, { domain }).state;
  // when each entity first entered the log (its observedAt may be far older: an author-history lookup returns old papers)
  const ingestedAt = new Map();
  for (const e of upTo) {
    if (e.kind !== 'observation.seen') continue;
    for (const spec of e.body.entities ?? []) {
      if (!spec?.type || spec.key === undefined || spec.key === null) continue;
      const id = `${spec.type}:${spec.key}`;
      const prev = ingestedAt.get(id);
      if (prev === undefined || e.ts < prev) ingestedAt.set(id, e.ts);
    }
  }
  state.ingestedAt = ingestedAt;
  return state;
}

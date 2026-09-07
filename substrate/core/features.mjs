// core/features.mjs — domain-agnostic entity features (v3).
//
// The learned value model needs a feature vector per entity, computed by the
// core from memory alone (the plug-in boundary is untouched: the plug-in's
// scalar score is just one more feature). Everything is bucketed so the
// hashed linear model sees categorical indicators plus a few linear terms.
import { DAY_MS, degree, neighbors, surprisal, burstScore, seriesLatest, idfOf, relationRecord } from './memory.mjs';
import { bucket } from './attention.mjs';
import { tokenize } from './embed.mjs';
import { bridgeScore } from './strategy.mjs';

export function entityFeatures(id, { memory, schema, now, degreeRanks, signalRanks, pluginScore = null, tokens = true }) {
  const e = memory.entities.get(id);
  if (!e) return {};
  const f = { [`type=${e.type}`]: 1 };
  f[`age=${bucket((now - e.firstSeen) / DAY_MS, [1, 3, 7, 30, 90])}`] = 1;
  f[`seen=${bucket(e.n, [1, 2, 5, 20])}`] = 1;
  f[`cent=${bucket(degreeRanks.percentile(e.type, degree(memory, id)), [0.25, 0.5, 0.75, 0.9])}`] = 1;
  if (pluginScore !== null) { f[`score=${bucket(pluginScore, [0.1, 0.2, 0.35, 0.5, 0.7])}`] = 1; f.scoreLin = pluginScore; }
  for (const r of schema.relations) {
    if (r.from === e.type) f[`out:${r.rel}=${bucket(degree(memory, id, r.rel, 'out'), [1, 2, 4, 8])}`] = 1;
    if (r.to === e.type) f[`in:${r.rel}=${bucket(degree(memory, id, r.rel, 'in'), [1, 2, 4, 8, 32])}`] = 1;
    if (r.from === e.type) {
      const br = bridgeScore(memory, id, r.rel, 'out', { mode: 'emerging', days: 7, now });
      if (br.score > 0) f[`bridge:${r.rel}=${bucket(br.score, [0.3, 0.7, 1.2])}`] = 1;
      // newcomer: an established entity with a new edge of this relation
      if (now - e.firstSeen >= 3 * DAY_MS) for (const n of neighbors(memory, id, r.rel, 'out')) { const rr = relationRecord(memory, id, r.rel, n); if (rr && rr.firstSeen >= now - 7 * DAY_MS && rr.n >= 2) { f[`newedge:${r.rel}`] = 1; break; } }
      // neighbours that are themselves newcomers (e.g. a paper whose author just moved)
      for (const n of neighbors(memory, id, r.rel, 'out')) {
        const ne = memory.entities.get(n);
        if (!ne || now - ne.firstSeen < 3 * DAY_MS || ne.n < 2) continue;
        for (const r2 of schema.relations) if (r2.from === ne.type) for (const m of neighbors(memory, n, r2.rel, 'out')) { const rr = relationRecord(memory, n, r2.rel, m); if (rr && rr.n >= 2 && rr.firstSeen >= now - 7 * DAY_MS) { f[`nbr-newedge:${r.rel}:${r2.rel}`] = 1; } }
      }
    }
  }
  for (const s of schema.signals) {
    if (s.type && s.type !== e.type) continue;
    const p = seriesLatest(e.signals.get(s.name));
    if (p) f[`sig:${s.name}=${bucket(signalRanks.percentile(e.type, s.name, p[1]), [0.2, 0.4, 0.6, 0.8, 0.95])}`] = 1;
  }
  // context: the strongest signal percentile among neighbours, per relation (a bridge whose topics are not yet hot ≠ one whose topics are)
  for (const r of schema.relations) {
    const dir = r.from === e.type ? 'out' : r.to === e.type ? 'in' : null;
    if (!dir) continue;
    const nType = dir === 'out' ? r.to : r.from;
    for (const s of schema.signals) {
      if (s.type && s.type !== nType) continue;
      let best = null;
      for (const n of neighbors(memory, id, r.rel, dir)) { const ne = memory.entities.get(n); const p = ne && seriesLatest(ne.signals.get(s.name)); if (p) { const q = signalRanks.percentile(nType, s.name, p[1]); if (best === null || q > best) best = q; } }
      if (best !== null) f[`nbr:${r.rel}:${s.name}=${bucket(best, [0.2, 0.4, 0.6, 0.8, 0.95])}`] = 1;
    }
  }
  if (e.text) {
    f[`surprisal=${bucket(surprisal(memory.terms, e.text), [2, 4, 6, 8])}`] = 1;
    f[`burst=${bucket(burstScore(memory.terms, e.text, now), [0.2, 0.5, 0.8])}`] = 1;
    if (tokens) {
      const toks = [...new Set(tokenize(e.text))].map((t) => [t, idfOf(memory.terms, t)]).sort((a, b) => b[1] - a[1]).slice(0, 6);
      for (const [t] of toks) f[`tok=${t}`] = 1;
    }
  }
  for (const s of e.sensors) f[`sensor=${s}`] = 1;
  return f;
}

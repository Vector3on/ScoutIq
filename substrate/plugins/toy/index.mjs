// plugins/toy/index.mjs — the toy domain plug-in. Two sensors over the
// synthetic world (a per-topic feed and an author-history lookup), a value
// function that only sees OBSERVABLE features in memory, and a debug hook the
// experiment harness uses to score outputs against the hidden truth.
import { ToyWorld, dayOf, DAY_MS, EPOCH } from './world.mjs';

export function createPlugin(options = {}) {
  const world = new ToyWorld(options.seed ?? 7, options.world ?? {});
  const epoch = options.epoch ?? EPOCH;
  const schema = {
    entityTypes: ['paper', 'author', 'topic'],
    primaryType: 'paper',
    relations: [
      { rel: 'authored_by', from: 'paper', to: 'author' },
      { rel: 'in_topic', from: 'paper', to: 'topic' },
      { rel: 'active_in', from: 'author', to: 'topic' },
    ],
    signals: [{ name: 'heat', type: 'topic' }, { name: 'topics', type: 'paper' }],
  };

  const docObservation = (doc, day) => ({
    externalId: doc.id,
    observedAt: epoch + day * DAY_MS,
    text: doc.title,
    entities: [
      { type: 'paper', key: doc.id, text: doc.title, attrs: { day: doc.day, topics: doc.topics.join(',') }, signals: { topics: doc.topics.length } },
      { type: 'author', key: doc.author },
      ...doc.topics.map((t) => ({ type: 'topic', key: t })),
    ],
    relations: [
      { from: `paper:${doc.id}`, rel: 'authored_by', to: `author:${doc.author}` },
      ...doc.topics.map((t) => ({ from: `paper:${doc.id}`, rel: 'in_topic', to: `topic:${t}` })),
      ...doc.topics.map((t) => ({ from: `author:${doc.author}`, rel: 'active_in', to: `topic:${t}` })),
    ],
  });

  const feed = {
    id: 'toy-feed',
    manifest: { id: 'toy-feed', version: '1', description: 'synthetic per-topic feed (no network)', dataClasses: ['local-synthetic'], endpoints: [], scale: { maxRequestsPerRun: 0 } },
    propose({ limit }) {
      return world.topics.slice(0, limit).map((t, i) => ({ params: { topic: i }, paramsKey: `topic=${t.id}`, estSeconds: 0.5, features: { topic: t.id } }));
    },
    poll(params, { now }) {
      const day = dayOf(now, epoch);
      const docs = [...world.docsForDay(day), ...world.docsForDay(day - 1)].filter((d) => d.topicIdx.includes(params.topic)).slice(0, 25);
      const observations = docs.map((d) => docObservation(d, d.day));
      // the topic entity itself carries a "heat" signal: how much the feed returned today
      observations.push({ externalId: `feed:${params.topic}:${day}`, observedAt: epoch + day * DAY_MS, entities: [{ type: 'topic', key: `t${params.topic}`, signals: { heat: docs.filter((d) => d.day === day).length } }], relations: [] });
      return { observations };
    },
  };

  const authorLookup = {
    id: 'toy-author',
    manifest: { id: 'toy-author', version: '1', description: 'synthetic author history lookup (no network)', dataClasses: ['local-synthetic'], endpoints: [], scale: { maxRequestsPerRun: 0 } },
    propose({ memory, stats, now, limit, helpers }) {
      const out = [];
      const ids = [...(memory.byType.get('author') ?? [])];
      const scored = ids.map((id) => {
        const st = stats.get(`author=${id.slice(7)}`);
        const stale = st ? (now - st.lastAt) / DAY_MS : 999;
        return [id, helpers.degree(memory, id, 'authored_by', 'in'), stale];
      }).filter((x) => x[2] >= 7).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      for (const [id, deg] of scored.slice(0, limit)) out.push({ params: { author: id.slice(7) }, paramsKey: `author=${id.slice(7)}`, estSeconds: 0.5, features: { deg: deg >= 4 ? 'hi' : 'lo' } });
      return out;
    },
    poll(params, { now }) {
      const day = dayOf(now, epoch);
      const docs = [];
      for (let d = Math.max(0, day - 40); d <= day && docs.length < 20; d++) for (const doc of world.docsForDay(d)) if (doc.author === params.author) docs.push(doc);
      return { observations: docs.map((d) => docObservation(d, d.day)) };
    },
  };

  const value = {
    /** Observable proxy: emerging (not habitual) bridge, author newcomer, rising terms, a little heat. */
    score(entity, { memory, now, helpers }) {
      const { neighbors, latestSignal, burstScore, relationRecord } = helpers;
      if (entity.type === 'paper') {
        const topics = [...neighbors(memory, entity.id, 'in_topic', 'out')];
        let bridge = 0;
        if (topics.length >= 2) {
          const [a, b] = topics;
          const A = neighbors(memory, a, 'in_topic', 'in'), B = neighbors(memory, b, 'in_topic', 'in');
          let both = 0, recent = 0;
          for (const x of A) if (B.has(x)) { both++; const r = relationRecord(memory, x, 'in_topic', a); if (r && r.firstSeen >= now - 5 * DAY_MS) recent++; }
          bridge = (recent / Math.max(1, both)) * Math.min(1, Math.log1p(recent) / Math.log(6));
        }
        let heat = 0;
        for (const t of topics) { const h = latestSignal(memory.entities.get(t), 'heat'); if (h !== null) heat = Math.max(heat, Math.min(1, h / 10)); }
        // a bridge whose topics are already hot is late; damp it
        bridge *= 1 - 0.5 * Math.max(0, heat - 0.5) * 2;
        let newcomer = 0;
        for (const a of neighbors(memory, entity.id, 'authored_by', 'out')) {
          const ae = memory.entities.get(a);
          if (!ae || now - ae.firstSeen < 3 * DAY_MS || ae.n < 2) continue;
          for (const t of topics) {
            const r = relationRecord(memory, a, 'active_in', t);
            // a burst (≥ 2 papers on a NEW edge), not a one-off
            if (r && r.n >= 2 && r.firstSeen >= now - 4 * DAY_MS && r.firstSeen >= entity.firstSeen - DAY_MS) newcomer = 1;
          }
        }
        const rising = burstScore(memory.terms, entity.text, now);
        return Math.min(1, 0.45 * bridge + 0.35 * newcomer + 0.2 * rising + 0.05 * heat);
      }
      if (entity.type === 'author') {
        let recent = 0;
        if (now - entity.firstSeen >= 3 * DAY_MS && entity.n >= 2) {
          for (const t of neighbors(memory, entity.id, 'active_in', 'out')) { const r = relationRecord(memory, entity.id, 'active_in', t); if (r && r.n >= 2 && r.firstSeen >= now - 4 * DAY_MS) recent = 1; }
        }
        return recent ? 0.3 : 0.03;
      }
      return 0.03;
    },
  };

  return {
    id: 'toy', version: '1', description: 'Synthetic world with hidden ground truth (falsification harness).',
    schema, sensors: [feed, authorLookup], value, sinks: [],
    debug: {
      world,
      trueValue(entityId, now = null) {
        if (entityId.startsWith('paper:')) { const d = world.docById(entityId.slice(6)); return d ? world.trueValue(d) : 0; }
        if (entityId.startsWith('author:') && now !== null) return world.authorValue(entityId.slice(7), dayOf(now, epoch));
        return 0;
      },
      epoch,
    },
  };
}
export default createPlugin;

// plugins/arxiv-lit/index.mjs — scientific-literature monitoring over the
// public arXiv API. Domain knowledge lives here and only here.
//
//   Sensor  : arxiv-api — category and keyword queries (official API, 1 request
//             per 3 s per its terms of use), plus categories the substrate
//             discovers through cross-listings.
//   Entities: paper (title+abstract text, version/category signals), category,
//             author (keyed pseudonyms only — no names are ever stored).
//   Value   : configured interests, cross-archive bridges that are emerging,
//             authors bursting into a new category, rising vocabulary.
import { parseArxivAtom, categoryDistance } from './atom.mjs';

const DAY_MS = 86400000;
const MAX_AUTHORS_FOR_COAUTHOR_EDGES = 6;

export function createPlugin(options = {}) {
  const categories = options.categories ?? ['cs.CR', 'cs.LG'];
  const interests = (options.interests ?? []).map((s) => String(s).toLowerCase());
  const maxResults = Math.min(200, Math.max(10, options.maxResults ?? 100));
  const discoverCategories = options.discoverCategories ?? true;

  const schema = {
    entityTypes: ['paper', 'author', 'category'],
    primaryType: 'paper',
    relations: [
      { rel: 'in_category', from: 'paper', to: 'category' },
      { rel: 'primary_category', from: 'paper', to: 'category' },
      { rel: 'authored_by', from: 'paper', to: 'author' },
      { rel: 'active_in', from: 'author', to: 'category' },
      { rel: 'coauthor', from: 'author', to: 'author' },
    ],
    signals: [{ name: 'version', type: 'paper' }, { name: 'nCategories', type: 'paper' }, { name: 'nAuthors', type: 'paper' }, { name: 'feedSize', type: 'category' }],
  };

  function toObservation(e, pseudonym, now) {
    const authors = e.authors.map((n) => pseudonym(n));
    const text = `${e.title}. ${e.summary}`.slice(0, 1500);
    const observedAt = e.updated ?? e.published ?? now;
    const entities = [
      { type: 'paper', key: e.id, text, attrs: { primary: e.primary, categories: e.categories.join(','), published: e.published, updated: e.updated, version: e.version, doi: e.doi, journalRef: e.journalRef, url: `https://arxiv.org/abs/${e.id}` }, signals: { version: e.version, nCategories: e.categories.length, nAuthors: e.authors.length } },
      ...e.categories.map((c) => ({ type: 'category', key: c })),
      ...authors.map((a) => ({ type: 'author', key: a })),
    ];
    const relations = [
      ...e.categories.map((c) => ({ from: `paper:${e.id}`, rel: 'in_category', to: `category:${c}` })),
      ...(e.primary ? [{ from: `paper:${e.id}`, rel: 'primary_category', to: `category:${e.primary}` }] : []),
      ...authors.map((a) => ({ from: `paper:${e.id}`, rel: 'authored_by', to: `author:${a}` })),
      ...(e.primary ? authors.map((a) => ({ from: `author:${a}`, rel: 'active_in', to: `category:${e.primary}` })) : []),
    ];
    const few = authors.slice(0, MAX_AUTHORS_FOR_COAUTHOR_EDGES);
    for (let i = 0; i < few.length; i++) for (let j = i + 1; j < few.length; j++) relations.push({ from: `author:${few[i] < few[j] ? few[i] : few[j]}`, rel: 'coauthor', to: `author:${few[i] < few[j] ? few[j] : few[i]}` });
    return { externalId: e.idWithVersion, observedAt, text, entities, relations };
  }

  const sensor = {
    id: 'arxiv-api',
    manifest: {
      id: 'arxiv-api', version: '1', description: 'arXiv API query endpoint (Atom). Public metadata; author names pseudonymized before storage.',
      terms: { url: 'https://info.arxiv.org/help/api/tou.html', officialApi: true, notes: 'One request every 3 seconds, single connection, identify your client.' },
      endpoints: [{ host: 'export.arxiv.org', pathPrefix: '/api/query', methods: ['GET'], minIntervalMs: 3000, dailyCap: 400, maxBytes: 4 * 1024 * 1024 }],
      auth: 'none', dataClasses: ['public-metadata', 'text', 'person'], scale: { maxRequestsPerRun: 30 },
    },
    propose({ memory, stats, now, limit, helpers }) {
      const out = [];
      const push = (kind, value, extra = {}) => out.push({ params: { kind, value }, paramsKey: `${kind}=${value}`, estRequests: 1, features: { kind, [kind]: value, ...extra } });
      for (const c of categories) push('cat', c, { configured: true });
      for (const k of interests) push('kw', k, { configured: true });
      if (discoverCategories) {
        const known = new Set(categories);
        const cands = [...(memory.byType.get('category') ?? [])].map((id) => id.slice(9)).filter((c) => !known.has(c))
          .map((c) => [c, helpers.degree(memory, `category:${c}`, 'in_category', 'in')]).sort((a, b) => b[1] - a[1]).slice(0, 4);
        for (const [c] of cands) push('cat', c, { configured: false });
      }
      return out.slice(0, limit);
    },
    async poll(params, { fetch, now, pseudonym }) {
      if (!pseudonym) throw new Error('arxiv-api needs the pseudonymizer (set LOAM_PSEUDONYM_SALT)');
      const q = params.kind === 'kw' ? `all:${JSON.stringify(String(params.value))}` : `cat:${params.value}`;
      const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(q)}&sortBy=lastUpdatedDate&sortOrder=descending&start=0&max_results=${maxResults}`;
      const res = await fetch(url, { headers: { accept: 'application/atom+xml' } });
      if (!res.ok) return { observations: [], blocked: res.blocked };
      const feed = parseArxivAtom(res.text);
      const observations = feed.entries.map((e) => toObservation(e, pseudonym, now));
      if (params.kind === 'cat') observations.push({ externalId: `feed:${params.value}:${Math.floor(now / DAY_MS)}`, observedAt: now, entities: [{ type: 'category', key: params.value, signals: { feedSize: feed.entries.length } }], relations: [] });
      return { observations };
    },
  };

  const value = {
    score(entity, { memory, now, helpers }) {
      const { neighbors, relationRecord, burstScore, latestSignal } = helpers;
      if (entity.type === 'paper') {
        const text = (entity.text ?? '').toLowerCase();
        const matched = interests.filter((k) => text.includes(k)).length;
        const interest = interests.length ? Math.min(1, matched / Math.min(3, interests.length)) : 0.3;
        const cats = [...neighbors(memory, entity.id, 'in_category', 'out')].map((id) => id.slice(9));
        let bridge = 0;
        if (cats.length >= 2) {
          let dist = 0, a = cats[0], b = cats[1];
          for (let i = 0; i < cats.length; i++) for (let j = i + 1; j < cats.length; j++) { const d = categoryDistance(cats[i], cats[j]); if (d > dist) { dist = d; a = cats[i]; b = cats[j]; } }
          const A = neighbors(memory, `category:${a}`, 'in_category', 'in'), B = neighbors(memory, `category:${b}`, 'in_category', 'in');
          let both = 0, recent = 0;
          for (const x of A) if (B.has(x)) { both++; const r = relationRecord(memory, x, 'in_category', `category:${a}`); if (r && r.firstSeen >= now - 14 * DAY_MS) recent++; }
          const emerging = both ? (recent / both) * Math.min(1, Math.log1p(recent) / Math.log(6)) : 0;
          bridge = dist * (0.4 + 0.6 * emerging);
        }
        let newcomer = 0;
        for (const a of neighbors(memory, entity.id, 'authored_by', 'out')) {
          const ae = memory.entities.get(a);
          if (!ae || now - ae.firstSeen < 30 * DAY_MS || ae.n < 2) continue;
          for (const c of cats) { const r = relationRecord(memory, a, 'active_in', `category:${c}`); if (r && r.n >= 2 && r.firstSeen >= now - 30 * DAY_MS) newcomer = 1; }
        }
        const rising = burstScore(memory.terms, entity.text, now, { window: 7, minDf: 5 });
        const version = latestSignal(entity, 'version') ?? 1;
        return Math.min(1, 0.35 * interest + 0.25 * bridge + 0.2 * newcomer + 0.2 * rising) * (version > 1 ? 0.9 : 1);
      }
      if (entity.type === 'author') {
        if (now - entity.firstSeen < 30 * DAY_MS || entity.n < 2) return 0.03;
        for (const c of neighbors(memory, entity.id, 'active_in', 'out')) { const r = relationRecord(memory, entity.id, 'active_in', c); if (r && r.n >= 2 && r.firstSeen >= now - 30 * DAY_MS) return 0.3; }
        return 0.03;
      }
      return 0.03;
    },
  };

  return { id: 'arxiv-lit', version: '1', description: 'Scientific-literature monitoring over the public arXiv API.', schema, sensors: [sensor], value, sinks: [] };
}
export default createPlugin;

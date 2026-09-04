// plugins/oss-health/index.mjs — open-source ecosystem health over public
// registries. Domain knowledge lives here and only here.
//
//   Sensors : npm-registry (package metadata, maintainers, dependencies),
//             npm-downloads (usage and its trend), depsdev (advisories,
//             OpenSSF scorecard, stars/forks/issues via Google's Open Source
//             Insights, no token), github-repos (optional, token-optional:
//             commit cadence, bus factor, releases).
//   Entities: package, repo, maintainer/contributor (keyed pseudonyms only).
//   Value   : usage × (maintenance silence, bus factor), advisories on used
//             packages, maintainer changes on established packages, rising usage.
//   The graph grows along dependency edges: dependencies of watched packages
//   are proposed for observation, bounded by budget and depth.
const DAY_MS = 86400000;

export function createPlugin(options = {}) {
  const packages = options.packages ?? [];
  const expandDependencies = options.expandDependencies ?? true;
  const maxDependencyDepth = options.maxDependencyDepth ?? 1;
  const github = options.github ?? false;
  const staleDays = options.staleDays ?? 3;

  const schema = {
    entityTypes: ['package', 'repo', 'maintainer', 'contributor'],
    primaryType: 'package',
    relations: [
      { rel: 'depends_on', from: 'package', to: 'package' },
      { rel: 'maintained_by', from: 'package', to: 'maintainer' },
      { rel: 'source', from: 'package', to: 'repo' },
      { rel: 'contributed_by', from: 'repo', to: 'contributor' },
    ],
    signals: [
      { name: 'downloadsWeek', type: 'package' }, { name: 'downloadsTrend', type: 'package' }, { name: 'versionsTotal', type: 'package' }, { name: 'daysSinceLastPublish', type: 'package' },
      { name: 'releases90d', type: 'package' }, { name: 'depsCount', type: 'package' }, { name: 'maintainers', type: 'package' }, { name: 'advisories', type: 'package' }, { name: 'depth', type: 'package' },
      { name: 'stars', type: 'repo' }, { name: 'forks', type: 'repo' }, { name: 'openIssues', type: 'repo' }, { name: 'scorecard', type: 'repo' }, { name: 'daysSincePush', type: 'repo' }, { name: 'topContributorShare', type: 'repo' }, { name: 'commits30d', type: 'repo' }, { name: 'archived', type: 'repo' },
    ],
  };

  const pkgId = (name) => `package:npm/${name}`;
  const encodePkg = (name) => encodeURIComponent(name).replace(/^%40/, '@');
  function repoFromUrl(u) {
    const m = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(String(u ?? ''));
    return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
  }
  function depthOf(memory, id, helpers) {
    const e = memory.entities.get(id);
    return e ? helpers.latestSignal(e, 'depth') ?? 0 : 0;
  }
  function stalePackages(memory, stats, now, helpers, key, limit) {
    const rows = [];
    for (const id of memory.byType.get('package') ?? []) {
      const name = id.slice(12);
      const st = stats.get(`${key}=${name}`);
      const stale = st ? (now - st.lastAt) / DAY_MS : 999;
      if (stale < staleDays) continue;
      const depth = depthOf(memory, id, helpers);
      if (depth > maxDependencyDepth) continue;
      rows.push([name, depth, helpers.latestSignal(memory.entities.get(id), 'downloadsWeek') ?? 0]);
    }
    return rows.sort((a, b) => a[1] - b[1] || b[2] - a[2] || (a[0] < b[0] ? -1 : 1)).slice(0, limit);
  }

  // --- npm registry ---------------------------------------------------------
  const npmRegistry = {
    id: 'npm-registry',
    manifest: {
      id: 'npm-registry', version: '1', description: 'npm registry package documents (public). Maintainer names pseudonymized before storage.',
      terms: { url: 'https://docs.npmjs.com/policies/terms', officialApi: true, notes: 'Public registry API; be gentle.' },
      endpoints: [{ host: 'registry.npmjs.org', pathPrefix: '/', methods: ['GET'], minIntervalMs: 500, dailyCap: 800, maxBytes: 8 * 1024 * 1024 }],
      auth: 'none', dataClasses: ['public-metadata', 'text', 'person'], scale: { maxRequestsPerRun: 60 },
    },
    propose({ memory, stats, now, limit, helpers }) {
      const out = [];
      const seen = new Set();
      const push = (name, depth, configured) => { if (seen.has(name)) return; seen.add(name); out.push({ params: { name, depth }, paramsKey: `pkg=${name}`, estRequests: 1, features: { configured, depth: String(depth) } }); };
      for (const p of packages) { const st = stats.get(`pkg=${p}`); if (!st || (now - st.lastAt) / DAY_MS >= staleDays) push(p, 0, true); }
      if (expandDependencies) for (const [name, depth] of stalePackages(memory, stats, now, helpers, 'pkg', limit)) push(name, depth, packages.includes(name));
      return out.slice(0, limit);
    },
    async poll(params, { fetch, now, pseudonym }) {
      if (!pseudonym) throw new Error('npm-registry needs the pseudonymizer (set LOAM_PSEUDONYM_SALT)');
      const res = await fetch(`https://registry.npmjs.org/${encodePkg(params.name)}`, { headers: { accept: 'application/json' } });
      if (!res.ok) return { observations: [], blocked: res.blocked };
      const doc = res.json();
      const latest = doc['dist-tags']?.latest;
      const v = doc.versions?.[latest] ?? {};
      const times = Object.entries(doc.time ?? {}).filter(([k]) => k !== 'created' && k !== 'modified').map(([, t]) => Date.parse(t)).filter(Number.isFinite).sort((a, b) => a - b);
      const last = times.length ? times[times.length - 1] : null;
      const deps = Object.keys(v.dependencies ?? {});
      const maintainers = (doc.maintainers ?? []).map((m) => (typeof m === 'string' ? m : m?.name)).filter(Boolean).map((n) => pseudonym(n));
      const repo = repoFromUrl(doc.repository?.url ?? doc.repository ?? doc.homepage);
      const entities = [
        { type: 'package', key: `npm/${params.name}`, text: `${doc.name ?? params.name} ${doc.description ?? ''} ${(doc.keywords ?? []).slice(0, 15).join(' ')}`.trim().slice(0, 600),
          attrs: { latest: latest ?? null, license: typeof doc.license === 'string' ? doc.license : doc.license?.type ?? null, created: Date.parse(doc.time?.created ?? '') || null, homepage: doc.homepage ?? null, repo },
          signals: { versionsTotal: times.length, daysSinceLastPublish: last ? Math.round((now - last) / DAY_MS) : 9999, releases90d: times.filter((t) => t >= now - 90 * DAY_MS).length, depsCount: deps.length, maintainers: maintainers.length, depth: params.depth ?? 0 } },
        ...deps.map((d) => ({ type: 'package', key: `npm/${d}`, signals: { depth: (params.depth ?? 0) + 1 } })),
        ...maintainers.map((m) => ({ type: 'maintainer', key: m })),
        ...(repo ? [{ type: 'repo', key: `github/${repo}` }] : []),
      ];
      const relations = [
        ...deps.map((d) => ({ from: pkgId(params.name), rel: 'depends_on', to: pkgId(d) })),
        ...maintainers.map((m) => ({ from: pkgId(params.name), rel: 'maintained_by', to: `maintainer:${m}` })),
        ...(repo ? [{ from: pkgId(params.name), rel: 'source', to: `repo:github/${repo}` }] : []),
      ];
      return { observations: [{ externalId: `pkg:${params.name}`, observedAt: now, text: entities[0].text, entities, relations }] };
    },
  };

  // --- npm downloads --------------------------------------------------------
  const npmDownloads = {
    id: 'npm-downloads',
    manifest: {
      id: 'npm-downloads', version: '1', description: 'npm download counts (public API).',
      terms: { url: 'https://github.com/npm/registry/blob/main/docs/download-counts.md', officialApi: true },
      endpoints: [{ host: 'api.npmjs.org', pathPrefix: '/downloads/', methods: ['GET'], minIntervalMs: 500, dailyCap: 800 }],
      auth: 'none', dataClasses: ['public-metadata'], scale: { maxRequestsPerRun: 60 },
    },
    propose({ memory, stats, now, limit, helpers }) {
      return stalePackages(memory, stats, now, helpers, 'dl', limit).map(([name, depth]) => ({ params: { name }, paramsKey: `dl=${name}`, estRequests: 1, features: { depth: String(depth) } }));
    },
    async poll(params, { fetch, now }) {
      const res = await fetch(`https://api.npmjs.org/downloads/range/last-month/${encodePkg(params.name)}`);
      if (!res.ok) return { observations: [], blocked: res.blocked };
      const doc = res.json();
      const days = (doc.downloads ?? []).map((d) => Number(d.downloads) || 0);
      const week = days.slice(-7).reduce((s, x) => s + x, 0), prev = days.slice(-14, -7).reduce((s, x) => s + x, 0);
      const trend = prev > 0 ? Math.max(-1, Math.min(1, (week - prev) / prev)) : 0;
      return { observations: [{ externalId: `dl:${params.name}`, observedAt: now, entities: [{ type: 'package', key: `npm/${params.name}`, signals: { downloadsWeek: week, downloadsTrend: Number(trend.toFixed(3)) } }], relations: [] }] };
    },
  };

  // --- deps.dev -------------------------------------------------------------
  const depsdev = {
    id: 'depsdev',
    manifest: {
      id: 'depsdev', version: '1', description: 'Open Source Insights (deps.dev) v3 API: advisories, project stars/issues, OpenSSF scorecard. No token.',
      terms: { url: 'https://docs.deps.dev/api/v3/', officialApi: true },
      endpoints: [{ host: 'api.deps.dev', pathPrefix: '/v3/', methods: ['GET'], minIntervalMs: 500, dailyCap: 800 }],
      auth: 'none', dataClasses: ['public-metadata'], scale: { maxRequestsPerRun: 60 },
    },
    propose({ memory, stats, now, limit, helpers }) {
      const rows = stalePackages(memory, stats, now, helpers, 'dd', limit).filter(([name]) => memory.entities.get(pkgId(name))?.attrs?.latest);
      return rows.map(([name, depth]) => ({ params: { name, version: memory.entities.get(pkgId(name)).attrs.latest, repo: memory.entities.get(pkgId(name)).attrs.repo ?? null }, paramsKey: `dd=${name}`, estRequests: 2, features: { depth: String(depth), hasRepo: !!memory.entities.get(pkgId(name)).attrs.repo } }));
    },
    async poll(params, { fetch, now }) {
      const observations = [];
      const vres = await fetch(`https://api.deps.dev/v3/systems/npm/packages/${encodeURIComponent(params.name)}/versions/${encodeURIComponent(params.version)}`);
      if (vres.ok) {
        const v = vres.json();
        const advisories = (v.advisoryKeys ?? []).length;
        const related = (v.relatedProjects ?? []).map((p) => p.projectKey?.id).filter((id) => id && id.startsWith('github.com/')).map((id) => id.slice(11).toLowerCase());
        const repo = params.repo ?? related[0] ?? null;
        observations.push({ externalId: `dd:${params.name}@${params.version}`, observedAt: now, entities: [{ type: 'package', key: `npm/${params.name}`, signals: { advisories }, attrs: { repo } }, ...(repo ? [{ type: 'repo', key: `github/${repo}` }] : [])], relations: repo ? [{ from: pkgId(params.name), rel: 'source', to: `repo:github/${repo}` }] : [] });
        if (repo) {
          const pres = await fetch(`https://api.deps.dev/v3/projects/${encodeURIComponent(`github.com/${repo}`)}`);
          if (pres.ok) {
            const p = pres.json();
            observations.push({ externalId: `ddp:${repo}`, observedAt: now, entities: [{ type: 'repo', key: `github/${repo}`, text: String(p.description ?? '').slice(0, 300), attrs: { license: p.license ?? null, homepage: p.homepage ?? null }, signals: { stars: Number(p.starsCount) || 0, forks: Number(p.forksCount) || 0, openIssues: Number(p.openIssuesCount) || 0, scorecard: Number(p.scorecard?.overallScore) || 0 } }], relations: [] });
          }
        }
      } else if (vres.blocked) return { observations, blocked: true };
      return { observations };
    },
  };

  // --- GitHub (optional) ----------------------------------------------------
  const githubRepos = {
    id: 'github-repos',
    manifest: {
      id: 'github-repos', version: '1', description: 'GitHub REST API for public repositories (commit cadence, bus factor, releases). Token optional via env.',
      terms: { url: 'https://docs.github.com/en/rest', officialApi: true, notes: 'Public repos only; token used only if the operator authorizes GH_PAT.' },
      endpoints: [{ host: 'api.github.com', pathPrefix: '/repos/', methods: ['GET'], minIntervalMs: 1000, dailyCap: 800 }],
      auth: 'token-optional', tokenEnv: 'GH_PAT', dataClasses: ['public-metadata', 'text', 'person'], scale: { maxRequestsPerRun: 40 },
    },
    propose({ memory, stats, now, limit }) {
      if (!github) return [];
      const rows = [];
      for (const id of memory.byType.get('repo') ?? []) {
        const st = stats.get(`repo=${id.slice(12)}`);
        if (st && (now - st.lastAt) / DAY_MS < staleDays) continue;
        rows.push(id.slice(12));
      }
      return rows.sort().slice(0, limit).map((r) => ({ params: { repo: r }, paramsKey: `repo=${r}`, estRequests: 3, features: {} }));
    },
    async poll(params, { fetch, now, pseudonym }) {
      if (!pseudonym) throw new Error('github-repos needs the pseudonymizer (set LOAM_PSEUDONYM_SALT)');
      const base = `https://api.github.com/repos/${params.repo}`;
      const r = await fetch(base, { auth: true, headers: { accept: 'application/vnd.github+json' } });
      if (!r.ok) return { observations: [], blocked: r.blocked };
      const repo = r.json();
      const signals = { stars: Number(repo.stargazers_count) || 0, forks: Number(repo.forks_count) || 0, openIssues: Number(repo.open_issues_count) || 0, daysSincePush: repo.pushed_at ? Math.round((now - Date.parse(repo.pushed_at)) / DAY_MS) : 9999, archived: repo.archived ? 1 : 0 };
      const relations = [];
      const entities = [{ type: 'repo', key: `github/${params.repo}`, text: String(repo.description ?? '').slice(0, 300), attrs: { license: repo.license?.spdx_id ?? null, defaultBranch: repo.default_branch ?? null }, signals }];
      const c = await fetch(`${base}/commits?per_page=50`, { auth: true, headers: { accept: 'application/vnd.github+json' } });
      if (c.ok) {
        const commits = c.json();
        const logins = commits.map((x) => x.author?.login ?? x.commit?.author?.name).filter(Boolean).map((n) => pseudonym(n));
        const counts = new Map(); for (const l of logins) counts.set(l, (counts.get(l) ?? 0) + 1);
        const top = Math.max(0, ...counts.values());
        signals.topContributorShare = logins.length ? Number((top / logins.length).toFixed(3)) : 0;
        signals.commits30d = commits.filter((x) => Date.parse(x.commit?.author?.date ?? '') >= now - 30 * DAY_MS).length;
        for (const l of new Set(logins)) { entities.push({ type: 'contributor', key: l }); relations.push({ from: `repo:github/${params.repo}`, rel: 'contributed_by', to: `contributor:${l}` }); }
      }
      return { observations: [{ externalId: `repo:${params.repo}`, observedAt: now, text: entities[0].text, entities, relations }] };
    },
  };

  const value = {
    score(entity, { memory, now, helpers }) {
      const { neighbors, latestSignal, relationRecord } = helpers;
      const clamp = (x) => Math.max(0, Math.min(1, x));
      if (entity.type === 'package') {
        const dl = latestSignal(entity, 'downloadsWeek');
        const usage = dl === null ? 0.3 : clamp(Math.log1p(dl) / Math.log(1e7));
        const silence = clamp(((latestSignal(entity, 'daysSinceLastPublish') ?? 0) - 180) / 365);
        const repoId = [...neighbors(memory, entity.id, 'source', 'out')][0];
        const repo = repoId ? memory.entities.get(repoId) : null;
        const share = repo ? latestSignal(repo, 'topContributorShare') : null;
        const maint = latestSignal(entity, 'maintainers');
        const bus = share !== null ? share : maint ? clamp(1 / maint) : 0.5;
        const advisories = clamp((latestSignal(entity, 'advisories') ?? 0) / 2);
        const trend = latestSignal(entity, 'downloadsTrend') ?? 0;
        let maintainerChange = 0;
        if (now - entity.firstSeen > 30 * DAY_MS) for (const m of neighbors(memory, entity.id, 'maintained_by', 'out')) { const r = relationRecord(memory, entity.id, 'maintained_by', m); if (r && r.firstSeen >= now - 30 * DAY_MS && r.firstSeen > entity.firstSeen) maintainerChange = 1; }
        const archived = repo ? latestSignal(repo, 'archived') ?? 0 : 0;
        const risk = clamp(0.5 * silence + 0.5 * bus + 0.5 * archived);
        return clamp(0.35 * usage * risk + 0.25 * advisories * usage + 0.2 * maintainerChange * usage + 0.2 * Math.max(0, trend));
      }
      if (entity.type === 'repo') {
        const stars = latestSignal(entity, 'stars') ?? 0, share = latestSignal(entity, 'topContributorShare'), push = latestSignal(entity, 'daysSincePush'), sc = latestSignal(entity, 'scorecard');
        const popularity = clamp(Math.log1p(stars) / Math.log(1e5));
        const risk = clamp(0.4 * (share ?? 0.5) + 0.3 * clamp(((push ?? 0) - 90) / 365) + 0.3 * (sc !== null && sc > 0 ? clamp((5 - sc) / 5) : 0.3));
        return clamp(0.6 * popularity * risk);
      }
      if (entity.type === 'maintainer' || entity.type === 'contributor') {
        if (now - entity.firstSeen < 30 * DAY_MS) return 0.03;
        for (const p of neighbors(memory, entity.id, entity.type === 'maintainer' ? 'maintained_by' : 'contributed_by', 'in')) { const r = relationRecord(memory, p, entity.type === 'maintainer' ? 'maintained_by' : 'contributed_by', entity.id); if (r && r.firstSeen >= now - 30 * DAY_MS) return 0.25; }
        return 0.03;
      }
      return 0.03;
    },
  };

  return { id: 'oss-health', version: '1', description: 'Open-source ecosystem health over public registries (npm, deps.dev, optional GitHub).', schema, sensors: [npmRegistry, npmDownloads, depsdev, githubRepos], value, sinks: [] };
}
export default createPlugin;

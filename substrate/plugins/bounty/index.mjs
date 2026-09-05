// plugins/bounty/index.mjs — the bounty-intelligence heartbeat as a Loam domain.
//
// FOUR LAYERS, ONE ORGANISM (DESIGN §"the four-layer model"):
//   anatomy   (where a bug could live)  — the 19-class / 95-seam atlas: data/anatomy.json
//   pathology (what has actually worked) — the 120-case catalog:        data/techniques.json
//   EV        (what a lead is worth)     — ScoutIq's evaluateTarget(): scripts/ev-core.mjs
//   Loam      (compounding memory + the operator's judgments)           — the substrate
//
// BOUNDARY (enforced by the substrate's policy layer, restated here so it is
// impossible to miss): PUBLIC DATA ONLY. This plugin observes public program/scope
// feeds, reasons about which *published* techniques fit a target's *inferred*
// anatomy, and PRIORITISES a queue. It NEVER tests, probes, scans, fetches, or
// exploits any live target. No payloads. Anatomy = the invariant that must hold,
// never how to break it. A robots/ToS/scope block is a stop signal (policy layer).
import { evaluateTarget, clamp, round } from '../../../scripts/ev-core.mjs';
import { buildSpine, coverageChart } from './spine.mjs';
import { fingerprintAsset } from './fingerprint.mjs';
import { loadTried } from './tried.mjs';
import { alphaQueueSink } from './digest.mjs';

const DAY = 86400000;
const COV_NORM = 220;      // saturation point for the untried-cell coverage term
const FRESH_WINDOW = 45;   // days; a target first seen within this window is "fresh"

// max_severity → a nominal payable ceiling in dollars when the feed omits amounts.
// PUBLIC INFERENCE, conservative: only applied when the program declares it pays.
const SEV_REWARD = { critical: 10000, high: 4000, medium: 1000, low: 250, none: 0 };

/** Normalise one raw program record across platforms (HackerOne fully; others best-effort). */
function normalizeProgram(platform, raw) {
  if (platform === 'hackerone' || raw.targets?.in_scope) {
    return {
      handle: raw.handle ?? raw.name, name: raw.name ?? raw.handle, url: raw.url ?? null, website: raw.website ?? null,
      offersBounties: !!raw.offers_bounties, status: raw.submission_state === 'open' ? 'open' : (raw.submission_state ?? 'unknown'),
      managed: !!raw.managed_program, resolvedReports: raw.resolvedReports ?? null,
      inScope: (raw.targets?.in_scope ?? []).map((a) => ({ identifier: a.asset_identifier, type: a.asset_type, eligible: a.eligible_for_bounty !== false, maxSeverity: a.max_severity ?? null, instruction: a.instruction ?? null })),
    };
  }
  // bugcrowd / intigriti / yeswehack best-effort
  const scope = raw.targets?.in_scope ?? raw.scopes ?? [];
  return {
    handle: raw.code ?? raw.handle ?? raw.name, name: raw.name, url: raw.url ?? null, website: raw.website ?? null,
    offersBounties: raw.max_payout != null ? Number(raw.max_payout) > 0 : !!raw.offers_bounties,
    status: (raw.status ?? raw.submission_state ?? 'open') === 'open' ? 'open' : 'unknown', managed: !!raw.managed,
    maxPayout: raw.max_payout != null ? Number(raw.max_payout) : null, resolvedReports: null,
    inScope: scope.map((a) => ({ identifier: a.target ?? a.asset_identifier ?? a.endpoint, type: (a.type ?? a.asset_type ?? 'OTHER'), eligible: a.eligible_for_bounty !== false, maxSeverity: a.max_severity ?? null, instruction: a.description ?? null })),
  };
}

function evForTarget(prog, asset, nowIso, settings) {
  const maxReward = prog.maxPayout != null ? prog.maxPayout
    : prog.offersBounties ? (SEV_REWARD[String(asset.maxSeverity ?? 'medium').toLowerCase()] ?? SEV_REWARD.medium) : 0;
  const program = {
    name: prog.name, id: `program:${prog.handle}`, handle: prog.handle, url: prog.url,
    paid: prog.offersBounties, status: prog.status, maxReward,
    inviteOnly: false, kycRequired: false, languages: [],
    launchedAt: null, createdAt: null, resolvedReports: prog.resolvedReports,
    policyText: prog.instruction ?? '',
  };
  const target = { type: asset.type, value: asset.identifier, key: asset.identifier, eligible: asset.eligible };
  return evaluateTarget(program, target, { now: nowIso, repoSignals: null, settings });
}

export function createPlugin(options = {}) {
  const spine = buildSpine(options.data);                 // built once; pure data
  const tried = loadTried(options.tried);                 // operator-owned Set of `${seamId}::${techId}` cells
  const settings = { researcherCountry: options.researcherCountry ?? 'IN', rewardCap: options.rewardCap ?? 50000, unknownProgramFloor: options.unknownProgramFloor ?? 'MEDIUM', unknownResolvedReports: options.unknownResolvedReports ?? 25, ...(options.settings ?? {}) };
  const feeds = options.feeds ?? [
    { id: 'hackerone', platform: 'hackerone', url: 'https://raw.githubusercontent.com/arkadiyt/bounty-targets-data/main/data/hackerone_data.json' },
  ];
  const maxProgramsPerFeed = options.maxProgramsPerFeed ?? 40;
  const maxTargetsPerProgram = options.maxTargetsPerProgram ?? 8;
  const maxTechniqueNodes = options.maxTechniqueNodes ?? 12;
  const staleDays = options.staleDays ?? 1;

  const schema = {
    entityTypes: ['target', 'program', 'class', 'technique'],
    primaryType: 'target',
    relations: [
      { rel: 'in_scope_of', from: 'target', to: 'program' },
      { rel: 'fingerprints_as', from: 'target', to: 'class' },     // inferred anatomy
      { rel: 'applicable', from: 'target', to: 'technique' },      // fingerprint-fitting, untried-first
    ],
    // Signals are the "eyes": the substrate's learned-observable layer evolves
    // programs over exactly these, and strategies rank by them.
    signals: [
      { name: 'ev', type: 'target' }, { name: 'pFindable', type: 'target' }, { name: 'pPayable', type: 'target' }, { name: 'pFirst', type: 'target' },
      { name: 'rewardCeiling', type: 'target' }, { name: 'exposedSeams', type: 'target' }, { name: 'applicableTechniques', type: 'target' },
      { name: 'distinctTechniques', type: 'target' }, { name: 'classesCount', type: 'target' }, { name: 'crowd', type: 'target' },
      { name: 'scopeAssets', type: 'target' }, { name: 'eligible', type: 'target' },
    ],
  };

  // live coverage cache: coverage depends on (classIds, fingerprints, tried); tried is fixed per load.
  const covCache = new Map();
  function coverageOf(entity) {
    const a = entity.attrs ?? {};
    if (!a.classIds) return null;
    const key = entity.id;
    if (covCache.has(key)) return covCache.get(key);
    const targetKey = entity.id.replace(/^target:/, '');
    const cc = coverageChart(spine, { classIds: a.classIds, fingerprints: a.fingerprints ?? [], key: targetKey }, tried);
    covCache.set(key, cc);
    return cc;
  }

  const sensor = {
    id: 'bounty-feed',
    manifest: {
      id: 'bounty-feed', version: '1',
      description: 'Public bug-bounty program/scope feeds (arkadiyt/bounty-targets-data). OSINT of already-public scope; the plugin never contacts any listed target.',
      terms: { url: 'https://github.com/arkadiyt/bounty-targets-data', officialApi: false, notes: 'Public dataset of published program scopes; read-only. Discovery evidence, not authorization.' },
      endpoints: [{ host: 'raw.githubusercontent.com', pathPrefix: '/arkadiyt/bounty-targets-data/', methods: ['GET'], minIntervalMs: 1000, dailyCap: 200, maxBytes: 32 * 1024 * 1024 }],
      auth: 'none', dataClasses: ['public-metadata', 'text'], scale: { maxRequestsPerRun: 8 },
    },
    propose({ stats, now, limit }) {
      const out = [];
      for (const f of feeds) {
        const st = stats.get(`feed=${f.id}`);
        const stale = st ? (now - st.lastAt) / DAY : 999;
        if (stale >= staleDays) out.push({ params: { feed: f }, paramsKey: `feed=${f.id}`, estRequests: 1, features: { feed: f.id } });
      }
      return out.slice(0, limit);
    },
    async poll(params, { fetch, now }) {
      const f = params.feed;
      const res = await fetch(f.url, { headers: { accept: 'application/json' } });
      if (!res.ok) return { observations: [], blocked: res.blocked };
      let raw;
      try { raw = res.json(); } catch { return { observations: [] }; }
      const programs = Array.isArray(raw) ? raw : (raw.programs ?? []);
      const nowIso = new Date(now).toISOString();
      const observations = [];
      for (const rp of programs.slice(0, maxProgramsPerFeed)) {
        const prog = normalizeProgram(f.platform, rp);
        if (!prog.inScope.length) continue;
        const programId = `program:${f.platform}/${prog.handle}`;
        let emittedProgram = false;
        for (const asset of prog.inScope.slice(0, maxTargetsPerProgram)) {
          if (!asset.identifier) continue;
          const fp = fingerprintAsset(asset, { name: prog.name, website: prog.website, instruction: asset.instruction });
          const ev = evForTarget(prog, asset, nowIso, settings);
          const slug = String(asset.identifier).replace(/[^a-z0-9._~/-]+/gi, '_').slice(0, 80);
          const targetKey = `${f.platform}/${prog.handle}#${slug}`;
          const cc = coverageChart(spine, { classIds: fp.classes, fingerprints: fp.fingerprints, key: targetKey }, tried);
          if (!cc.exposedSeams) continue;                 // no plausible seam → not a lead
          const targetId = `target:${targetKey}`;
          const crowd = round(clamp(1 - ev.pFirst), 3);   // pFirst already blends youth + low recorded crowd
          const entities = [{
            type: 'target', key: targetKey,
            text: `${asset.identifier} — ${fp.classes.join('/')} · ${prog.name}`.slice(0, 300),
            attrs: {
              platform: f.platform, programHandle: prog.handle, programUrl: prog.url, assetValue: asset.identifier, assetType: fp.assetType,
              classIds: fp.classes, fingerprints: fp.fingerprints, maxSeverity: asset.maxSeverity,
              workflow: ev.workflow, findableClass: ev.findableClass, evClass: fp.evClass, offersBounties: prog.offersBounties,
              excludeReason: ev.excludeReason, evReason: ev.reason,
            },
            signals: {
              ev: round(ev.evScore, 2), pFindable: ev.pFindable, pPayable: ev.pPayable, pFirst: ev.pFirst, rewardCeiling: ev.effectiveReward,
              exposedSeams: cc.exposedSeams, applicableTechniques: cc.applicableTechniques, distinctTechniques: cc.distinctTechniques,
              classesCount: fp.classes.length, crowd, scopeAssets: prog.inScope.length, eligible: asset.eligible ? 1 : 0,
            },
          }];
          const relations = [{ from: targetId, rel: 'in_scope_of', to: programId }];
          if (!emittedProgram) {
            entities.push({ type: 'program', key: `${f.platform}/${prog.handle}`, text: `${prog.name} (${f.platform})`.slice(0, 200), attrs: { url: prog.url, website: prog.website, offersBounties: prog.offersBounties, status: prog.status }, signals: {} });
            emittedProgram = true;
          }
          for (const classId of fp.classes) {
            const cls = spine.classById.get(classId);
            if (!cls) continue;
            entities.push({ type: 'class', key: classId, text: `${cls.systemClass} — seams: ${(cls.seams ?? []).map((s) => s.name).slice(0, 6).join('; ')}`.slice(0, 300), attrs: { systemClass: cls.systemClass, seams: (cls.seams ?? []).length } });
            relations.push({ from: targetId, rel: 'fingerprints_as', to: `class:${classId}` });
          }
          // representative untried technique nodes (bounded), so the graph/behaviour layer can traverse the spine
          const distinct = new Map();
          for (const c of cc.chart) for (const s of c.seams) for (const t of s.techniques) if (!t.tried && !distinct.has(t.id)) distinct.set(t.id, t);
          for (const t of [...distinct.values()].slice(0, maxTechniqueNodes)) {
            entities.push({ type: 'technique', key: t.id, text: `${t.title} — ${t.families.join('/')}`.slice(0, 300), attrs: { number: t.number, families: t.families, source: t.source, sourceUrl: t.sourceUrl } });
            relations.push({ from: targetId, rel: 'applicable', to: `technique:${t.id}` });
          }
          observations.push({ externalId: `bounty:${targetKey}`, observedAt: now, text: entities[0].text, entities, relations });
        }
      }
      return { observations };
    },
  };

  const value = {
    score(entity, { now, helpers }) {
      const { latestSignal } = helpers;
      if (entity.type === 'target') {
        const ev = latestSignal(entity, 'ev') ?? 0;
        const cap = settings.rewardCap;
        const evNorm = clamp(Math.log1p(Math.max(0, ev)) / Math.log1p(cap));
        const cc = coverageOf(entity);
        const untried = cc ? cc.untriedTechniques : (latestSignal(entity, 'applicableTechniques') ?? 0);
        const cov = clamp(Math.log1p(untried) / Math.log1p(COV_NORM));
        const freshDays = (now - entity.firstSeen) / DAY;
        const fresh = clamp((FRESH_WINDOW - freshDays) / FRESH_WINDOW);
        const lowCrowd = clamp(1 - (latestSignal(entity, 'crowd') ?? 0.5));
        const base = evNorm * cov;                        // ScoutIq EV × untried seam-coverage
        // fresh + low-crowd lift it; a small floor keeps fresh, technique-rich, low/zero-EV
        // targets visible as a watch list rather than vanishing.
        return clamp(base * (0.7 + 0.2 * fresh + 0.1 * lowCrowd) + 0.05 * cov * fresh);
      }
      if (entity.type === 'program' || entity.type === 'class' || entity.type === 'technique') return 0.02;
      return 0.02;
    },
  };

  return {
    id: 'bounty', version: '1',
    description: 'Bounty-intelligence heartbeat: anatomy (atlas) × pathology (120 cases) × EV (ScoutIq) × Loam memory/judgments. Observe-only; delivers a prioritised queue, never tests a target.',
    schema, sensors: [sensor], value,
    sinks: [alphaQueueSink({ spine, tried, settings, coverageOf })],
    // exposed for the digest, tests, and the report
    _spine: spine, _tried: tried, _coverageChart: (t) => coverageChart(spine, t, tried),
  };
}
export default createPlugin;

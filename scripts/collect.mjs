import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  datasetSignature,
  mergePrograms,
  normalizeSource,
  publicProgram,
  reconcilePrograms,
} from "./radar-core.mjs";
import { evaluateProgram } from "./ev-core.mjs";
import {
  enrichRepositoryCache,
  repositorySignalsFor,
} from "./repo-enrichment.mjs";
import {
  enrichPolicyCache,
  policySignalsFor,
} from "./policy-enrichment.mjs";
import { enrichLiveCache, liveStateFor } from "./live-enrichment.mjs";

const root = resolve(import.meta.dirname, "..");
const paths = {
  sources: resolve(root, "config/sources.json"),
  preferences: resolve(root, "config/preferences.json"),
  manual: resolve(root, "config/manual-programs.json"),
  overrides: resolve(root, "config/program-overrides.json"),
  liveConfig: resolve(root, "config/live-targets.json"),
  audited: resolve(root, "data/audited.json"),
  state: resolve(root, "data/state.json"),
  repoCache: resolve(root, "data/repo-cache.json"),
  policyCache: resolve(root, "data/policy-cache.json"),
  liveCache: resolve(root, "data/live-cache.json"),
  output: resolve(root, "public/data/programs.json"),
  events: resolve(root, "public/data/events.json"),
  run: resolve(root, ".radar-run.json"),
};

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

function pause(milliseconds) {
  return new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
}

async function fetchJson(source) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(source.url, {
        headers: {
          accept: "application/json",
          "user-agent": "ScopePulse/0.1 (+https://github.com/)",
        },
        signal: AbortSignal.timeout(source.timeoutMs ?? 25_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const declaredBytes = Number(response.headers.get("content-length") ?? 0);
      if (declaredBytes && declaredBytes > source.maxBytes) throw new Error("payload exceeds configured size cap");
      const text = await response.text();
      if (Buffer.byteLength(text) > source.maxBytes) throw new Error("payload exceeds configured size cap");
      const payload = JSON.parse(text);
      const records = normalizeSource(source, payload);
      if (records.length < (source.minRecords ?? 1)) throw new Error(`only ${records.length} usable paid records`);
      return { source, records, status: "ok" };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await pause(attempt * 1_200);
    }
  }
  return { source, records: null, status: "error", error: String(lastError?.message ?? lastError).slice(0, 180) };
}

function publicHealth(health) {
  return health.map(({ id, label, status, count, error }) => ({
    id,
    label,
    status,
    count,
    ...(error ? { error } : {}),
  }));
}

const now = new Date().toISOString();
const sourceConfig = await readJson(paths.sources, { sources: [] });
const preferences = await readJson(paths.preferences, { reviewedPrograms: [], minReward: 1000 });
const manualRecords = await readJson(paths.manual, []);
const overrideConfig = await readJson(paths.overrides, { defaults: {}, programs: {} });
const liveConfig = await readJson(paths.liveConfig, { targets: [] });
const audited = await readJson(paths.audited, { entries: {} });
const publicPrior = await readJson(paths.output, { programs: [], meta: {} });
const prior = await readJson(paths.state, {
  version: 0,
  generatedAt: null,
  sourceSnapshots: {},
  sourceHealth: [],
  programs: publicPrior.programs ?? [],
  events: [],
});
const priorRepoCache = await readJson(paths.repoCache, { version: 2, repositories: {} });
const priorPolicyCache = await readJson(paths.policyCache, { version: 2, policies: {} });
const priorLiveCache = await readJson(paths.liveCache, { version: 2, states: {} });

const remoteResults = await Promise.all(sourceConfig.sources.map(fetchJson));
const nextSnapshots = { ...prior.sourceSnapshots };
const health = [];

for (const result of remoteResults) {
  if (result.status === "ok") {
    nextSnapshots[result.source.id] = result.records;
    health.push({ id: result.source.id, label: result.source.label, status: "ok", count: result.records.length });
  } else {
    const preserved = nextSnapshots[result.source.id] ?? [];
    health.push({
      id: result.source.id,
      label: result.source.label,
      status: "error",
      count: preserved.length,
      error: `Preserved previous snapshot: ${result.error}`,
    });
  }
}

if (manualRecords.length) {
  const manualSource = {
    id: "manual",
    label: "Manual public programs",
    platform: "Self-hosted",
    adapter: "generic",
    homepage: "https://github.com/",
    priority: 5,
    paidOnly: true,
  };
  const records = normalizeSource(manualSource, manualRecords);
  nextSnapshots.manual = records;
  health.push({ id: "manual", label: manualSource.label, status: "ok", count: records.length });
}

const merged = mergePrograms(Object.values(nextSnapshots).flat());
const migratingToV2 = Number(prior.version ?? 0) < 2;
const previousPrograms = migratingToV2 ? [] : prior.programs;
const baseline = previousPrograms.length === 0;
const reconciliation = reconcilePrograms(merged, previousPrograms, now, { baseline });
const enrichmentMode = process.env.ENRICH_MODE ?? (process.argv.includes("--nightly") ? "nightly" : "hourly");
const numericEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};
const repoBudget = numericEnv("REPO_ENRICH_BUDGET", enrichmentMode === "nightly" ? 120 : 8);
const policyBudget = numericEnv("POLICY_ENRICH_BUDGET", enrichmentMode === "nightly" ? 80 : 4);
const repoEnrichment = await enrichRepositoryCache(reconciliation.programs, priorRepoCache, {
  now,
  budget: repoBudget,
  ttlHours: enrichmentMode === "nightly" ? 24 * 7 : 24 * 3,
});
const policyEnrichment = await enrichPolicyCache(reconciliation.programs, priorPolicyCache, {
  now,
  budget: policyBudget,
  ttlHours: 24 * 7,
  minimumPayableReward: overrideConfig.defaults?.minimumPayableReward ?? preferences.minReward ?? 1_000,
});
const liveEnrichment = await enrichLiveCache(reconciliation.programs, liveConfig, priorLiveCache, { now });

function programOverride(program) {
  return overrideConfig.programs?.[program.id]
    ?? overrideConfig.programs?.[program.name]
    ?? overrideConfig.programs?.[program.name.toLowerCase()]
    ?? {};
}

const evaluatedPrograms = reconciliation.programs.map((program) => {
  const policySignals = policySignalsFor(program, policyEnrichment.cache);
  const resolvedReports = program.resolvedReports ?? policySignals?.resolvedReports ?? null;
  const targetContexts = new Map((program.targets ?? []).map((target) => [target.key, {
    repoSignals: repositorySignalsFor(target, repoEnrichment.cache),
    liveState: liveStateFor(target, liveEnrichment.cache),
  }]));
  return evaluateProgram({ ...program, resolvedReports }, {
    now,
    audited,
    policySignals,
    targetContexts,
    settings: {
      ...overrideConfig.defaults,
      minimumPayableReward: overrideConfig.defaults?.minimumPayableReward ?? preferences.minReward ?? 1_000,
      programOverride: programOverride(program),
    },
  });
}).sort((a, b) => {
  if (Boolean(a.excludeReason) !== Boolean(b.excludeReason)) return a.excludeReason ? 1 : -1;
  return b.evScore - a.evScore || b.pFindable - a.pFindable || a.name.localeCompare(b.name);
});

const evaluatedById = new Map(evaluatedPrograms.map((program) => [program.id, program]));
for (const event of reconciliation.events) {
  const program = evaluatedById.get(event.programId);
  if (program) {
    event.score = program.score;
    event.evScore = program.evScore;
    event.workflow = program.workflow;
    event.excludeReason = program.excludeReason;
  }
}
const recentEvents = [...reconciliation.events, ...(prior.events ?? [])]
  .filter((event, index, array) => array.findIndex((candidate) => candidate.id === event.id) === index)
  .slice(0, 200);

const statePrograms = evaluatedPrograms.map((program) => publicProgram(program, Number.MAX_SAFE_INTEGER));
const publicPrograms = evaluatedPrograms.map((program) => publicProgram(program));
const structural = {
  snapshots: nextSnapshots,
  health: publicHealth(health),
  programs: statePrograms,
  events: recentEvents,
};
const priorStructural = {
  snapshots: prior.sourceSnapshots,
  health: prior.sourceHealth,
  programs: prior.programs,
  events: prior.events,
};
const changed = baseline || datasetSignature(structural) !== datasetSignature(priorStructural);
const generatedAt = changed ? now : prior.generatedAt ?? now;

const state = {
  version: 2,
  generatedAt,
  sourceSnapshots: nextSnapshots,
  sourceHealth: publicHealth(health),
  programs: statePrograms,
  events: recentEvents,
};
const payload = {
  meta: {
    generatedAt,
    mode: "live",
    sourceCount: health.length,
    healthySourceCount: health.filter((source) => source.status === "ok").length,
    programCount: publicPrograms.length,
    targetCount: publicPrograms.reduce((sum, program) => sum + program.targetCount, 0),
    eventCount: recentEvents.length,
    rankedProgramCount: publicPrograms.filter((program) => !program.excludeReason && program.evScore > 0).length,
    excludedProgramCount: publicPrograms.filter((program) => Boolean(program.excludeReason)).length,
    repoEnrichment: repoEnrichment.stats,
    policyEnrichment: policyEnrichment.stats,
    liveEnrichment: liveEnrichment.stats,
    enrichmentMode,
    sources: publicHealth(health),
  },
  programs: publicPrograms,
  preferences,
};
const eventPayload = { generatedAt, events: recentEvents };
const runPayload = { changed, baseline, generatedAt: now, events: reconciliation.events, health: publicHealth(health) };

if (changed) {
  await Promise.all([
    writeJsonAtomic(paths.state, state),
    writeJsonAtomic(paths.repoCache, repoEnrichment.cache),
    writeJsonAtomic(paths.policyCache, policyEnrichment.cache),
    writeJsonAtomic(paths.liveCache, liveEnrichment.cache),
    writeJsonAtomic(paths.output, payload),
    writeJsonAtomic(paths.events, eventPayload),
  ]);
}
await writeJsonAtomic(paths.run, runPayload);

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\nevent_count=${reconciliation.events.length}\nranked_count=${payload.meta.rankedProgramCount}\nexcluded_count=${payload.meta.excludedProgramCount}\n`);
}

const healthy = health.filter((source) => source.status === "ok").length;
console.log(`ScoutIQ v2: ${payload.meta.rankedProgramCount}/${publicPrograms.length} payable candidates, ${payload.meta.excludedProgramCount} hard-excluded, ${repoEnrichment.stats.updated} repos enriched, ${healthy}/${health.length} sources healthy${changed ? "." : "; no dataset change."}`);

if (healthy === 0) process.exitCode = 1;

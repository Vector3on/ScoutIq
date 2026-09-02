import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  datasetSignature,
  mergePrograms,
  normalizeSource,
  publicProgram,
  reconcilePrograms,
} from "./radar-core.mjs";

const root = resolve(import.meta.dirname, "..");
const paths = {
  sources: resolve(root, "config/sources.json"),
  preferences: resolve(root, "config/preferences.json"),
  manual: resolve(root, "config/manual-programs.json"),
  state: resolve(root, "data/state.json"),
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
const prior = await readJson(paths.state, {
  version: 1,
  generatedAt: null,
  sourceSnapshots: {},
  sourceHealth: [],
  programs: [],
  events: [],
});

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
const baseline = prior.programs.length === 0;
const reconciliation = reconcilePrograms(merged, prior.programs, now, { baseline });
const recentEvents = [...reconciliation.events, ...(prior.events ?? [])]
  .filter((event, index, array) => array.findIndex((candidate) => candidate.id === event.id) === index)
  .slice(0, 200);

const publicPrograms = reconciliation.programs.map((program) => publicProgram(program));
const structural = {
  snapshots: nextSnapshots,
  health: publicHealth(health),
  programs: reconciliation.programs,
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
  version: 1,
  generatedAt,
  sourceSnapshots: nextSnapshots,
  sourceHealth: publicHealth(health),
  programs: reconciliation.programs,
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
    writeJsonAtomic(paths.output, payload),
    writeJsonAtomic(paths.events, eventPayload),
  ]);
}
await writeJsonAtomic(paths.run, runPayload);

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\nevent_count=${reconciliation.events.length}\n`);
}

const healthy = health.filter((source) => source.status === "ok").length;
console.log(`ScopePulse: ${publicPrograms.length} paid programs, ${reconciliation.events.length} new events, ${healthy}/${health.length} sources healthy${changed ? "." : "; no dataset change."}`);

if (healthy === 0) process.exitCode = 1;

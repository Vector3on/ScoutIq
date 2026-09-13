import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LIVE = new Set(["live-web", "live-api", "live-contract", "ai-agent"]);

export function filterLane(program, lane = "default") {
  if (program.excludeReason || Number(program.evScore ?? 0) <= 0) return false;
  if (lane === "live") return LIVE.has(program.workflow);
  if (lane === "fresh-source") return Number(program.freshCodeIndex ?? 0) > 50 && program.workflow === "static-source";
  return program.workflow !== "static-source-hardened";
}

export function shortlist(programs, { lane = "default", limit = 25 } = {}) {
  return [...programs]
    .filter((program) => filterLane(program, lane))
    .sort((a, b) => Number(b.evScore ?? 0) - Number(a.evScore ?? 0) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

// --- fresh-niche lane: surface NEW + NICHE + SUPER-FRESH source-available repos ---
// EV ranking structurally favors high-reward flagships (Auth0 $50k, Fireblocks
// $150k) and the evScore>0 gate hides every niche repo whose program lists no
// public reward. This lane ranks individual in-scope repositories by freshness and
// obscurity using the GitHub/GitLab signals already gathered during enrichment,
// so forgotten, recently-changed, low-star repos rise to the top. It reads only
// existing data and does not touch the EV pipeline or the other lanes.
const NICHE_STAR_CAP = 400; // at or above this a repo is not "niche"
const FRESH_PUSH_DAYS = 60; // pushed within N days counts as fresh
const NEW_CREATE_DAYS = 90; // created within N days counts as new

function ageInDays(iso, now) {
  if (!iso) return null;
  const then = Date.parse(iso);
  return Number.isFinite(then) ? Math.round((now - then) / 86_400_000) : null;
}

export function nicheScore(rs, now = Date.now()) {
  if (!rs || rs.status !== "ok") return null;
  const pushed = ageInDays(rs.pushedAt, now);
  const created = ageInDays(rs.createdAt, now);
  const stars = Number(rs.stars ?? Infinity);
  const contributors = Number(rs.contributorsCount ?? Infinity);
  const ageY = Number(rs.ageY ?? Infinity);
  const commits30d = Number(rs.commits30d ?? 0);
  const filesAdded90d = Number(rs.filesAdded90d ?? 0);

  // Freshness: recent change and new files are the point.
  let freshness = 0;
  if (pushed != null) freshness += pushed <= 7 ? 30 : pushed <= 30 ? 20 : pushed <= 60 ? 10 : 0;
  if (created != null) freshness += created <= 60 ? 25 : created <= 180 ? 10 : 0;
  freshness += Math.min(20, commits30d);
  freshness += Math.min(15, filesAdded90d);

  // Nicheness: forgotten, low-star, small, young beats flagship.
  let niche = 0;
  niche += stars < 25 ? 25 : stars < 100 ? 15 : stars < NICHE_STAR_CAP ? 5 : 0;
  niche += contributors < 10 ? 10 : contributors < 50 ? 5 : 0;
  niche += ageY < 1 ? 10 : ageY < 3 ? 5 : 0;

  return { score: freshness + niche, freshness, niche, pushed, created, stars };
}

export function nicheRepos(programs, { limit = 25 } = {}, now = Date.now()) {
  const rows = [];
  const seen = new Set();
  for (const program of programs) {
    if (program.excludeReason) continue; // honor pipeline hard-exclusions (incl. audited memory)
    for (const target of program.targets ?? []) {
      const rs = target.repoSignals;
      if (!rs || rs.status !== "ok" || !rs.fullName) continue;
      const scored = nicheScore(rs, now);
      if (!scored) continue;
      const isFresh =
        (scored.pushed != null && scored.pushed <= FRESH_PUSH_DAYS) ||
        (scored.created != null && scored.created <= NEW_CREATE_DAYS);
      const isNiche = scored.stars < NICHE_STAR_CAP;
      if (!isFresh || !isNiche) continue; // only new/niche/super-fresh repos qualify
      if (seen.has(rs.fullName)) continue;
      seen.add(rs.fullName);
      rows.push({
        repo: rs.fullName,
        provider: rs.provider,
        program: program.name,
        platform: program.platform,
        maxReward: program.maxReward ?? null,
        paid: program.paid === true,
        kycRequired: program.kycRequired === true,
        safeHarbor: program.safeHarbor ?? null,
        url: program.url,
        stars: scored.stars,
        pushedDays: scored.pushed,
        createdDays: scored.created,
        filesAdded90d: Number(rs.filesAdded90d ?? 0),
        commits30d: Number(rs.commits30d ?? 0),
        commits90d: Number(rs.commits90d ?? 0),
        langs: Object.keys(rs.languages ?? {}).slice(0, 3).join(","),
        nicheScore: scored.score,
        freshness: scored.freshness,
        niche: scored.niche,
      });
    }
  }
  return rows
    .sort((a, b) => b.nicheScore - a.nicheScore || a.stars - b.stars || a.repo.localeCompare(b.repo))
    .slice(0, limit);
}

function argsOf(argv) {
  const value = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
  };
  return {
    lane: value("--lane", "default"),
    format: value("--format", "table"),
    limit: Math.max(1, Math.min(500, Number(value("--limit", "25")) || 25)),
  };
}

function compactMoney(value) {
  return new Intl.NumberFormat("en", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(value ?? 0));
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  if (!["default", "live", "fresh-source", "fresh-niche"].includes(args.lane)) {
    throw new Error("--lane must be live, fresh-source, or fresh-niche (omit it for the default lane)");
  }
  const root = resolve(import.meta.dirname, "..");
  const payload = JSON.parse(await readFile(resolve(root, "public/data/programs.json"), "utf8"));
  if (args.lane === "fresh-niche") {
    const repos = nicheRepos(payload.programs ?? [], args);
    if (args.format === "json") {
      process.stdout.write(`${JSON.stringify(repos, null, 2)}\n`);
      return;
    }
    if (args.format === "ndjson") {
      process.stdout.write(`${repos.map((repo) => JSON.stringify(repo)).join("\n")}\n`);
      return;
    }
    console.table(repos.map((repo, index) => ({
      rank: index + 1,
      repo: repo.repo,
      "stars": repo.stars,
      "push_d": repo.pushedDays,
      "new_d": repo.createdDays,
      "add90d": repo.filesAdded90d,
      score: repo.nicheScore,
      platform: repo.platform,
      reward: compactMoney(repo.maxReward),
      program: repo.program,
    })));
    return;
  }
  const rows = shortlist(payload.programs ?? [], args);
  if (args.format === "json") {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  if (args.format === "ndjson") {
    process.stdout.write(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    return;
  }
  console.table(rows.map((program, index) => ({
    rank: index + 1,
    program: program.name,
    workflow: program.workflow,
    ceiling: program.payableSeverityCeiling,
    EV: compactMoney(program.evScore),
    reason: program.honestReason ?? program.reasons?.[0] ?? "No reason available",
  })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`ScoutIQ query failed: ${error.message}`);
    process.exitCode = 1;
  });
}

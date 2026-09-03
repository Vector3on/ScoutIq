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
  if (!["default", "live", "fresh-source"].includes(args.lane)) {
    throw new Error("--lane must be live or fresh-source (omit it for the default lane)");
  }
  const root = resolve(import.meta.dirname, "..");
  const payload = JSON.parse(await readFile(resolve(root, "public/data/programs.json"), "utf8"));
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

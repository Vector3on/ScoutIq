// ScoutIQ source-audit CLI.
//
//   node scripts/audit.mjs --path <dir>            # scan a checked-out repo (SRC lane)
//   node scripts/audit.mjs --path . --format md --report out.md
//   node scripts/audit.mjs --coverage             # what is automated vs. handed to the human
//   node scripts/audit.mjs --live-check <url...>   # scope-guard a live target (does NOT hit it)
//
// The scanner only reads local source. It never sends a request anywhere. The
// live lane is yours to run, against verified scope, under safe harbor.

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve, relative, extname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadRules, scanText, rankSeeds, summarize, coverage as computeCoverage, extToLang } from "./audit-core.mjs";
import { renderMarkdown } from "./audit-report.mjs";
import { loadEngagementConfig, resolveEngagement, checkTarget } from "./scope-guard.mjs";

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next", ".wrangler", "coverage",
  "vendor", ".sites-runtime", "out", ".cache", "__pycache__", ".venv", "venv",
  "public", "drizzle",
]);

const SCAN_EXTS = new Set([
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "rb", "php", "java", "go",
  "cs", "rs", "c", "h", "cpp", "cc", "cxx", "hpp", "kt", "swift",
  "json", "yml", "yaml", "env", "sh", "sql", "html", "vue", "svelte",
]);

const MAX_FILE_BYTES = 1_500_000;

function parseArgs(argv) {
  const value = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
  };
  const multi = (flag) => {
    const out = [];
    let i = argv.indexOf(flag);
    if (i < 0) return out;
    for (let k = i + 1; k < argv.length && !argv[k].startsWith("--"); k += 1) out.push(argv[k]);
    return out;
  };
  return {
    path: value("--path", "."),
    format: value("--format", "table"),
    report: value("--report", null),
    minConfidence: value("--min-confidence", "low"),
    section: value("--section", null),
    coverage: argv.includes("--coverage"),
    liveCheck: multi("--live-check"),
    engagement: value("--engagement", undefined),
    limit: Math.max(1, Math.min(2000, Number(value("--limit", "200")) || 200)),
  };
}

async function walk(dir, root, files = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(full, root, files);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).slice(1).toLowerCase();
      if (!SCAN_EXTS.has(ext)) continue;
      if (/[.-](min|bundle)\.(js|css)$/.test(entry.name)) continue;
      if (/package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$/.test(entry.name)) continue;
      files.push(full);
    }
  }
  return files;
}

const CONF_ORDER = { high: 3, medium: 2, low: 1 };

async function runScan(args) {
  const root = resolve(import.meta.dirname, "..");
  const rules = await loadRules(root);
  const scanRoot = resolve(process.cwd(), args.path);
  const files = await walk(scanRoot, scanRoot);

  const allSeeds = [];
  let scanned = 0;
  for (const file of files) {
    let text;
    try {
      const info = await stat(file);
      if (info.size > MAX_FILE_BYTES) continue;
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    scanned += 1;
    const lang = extToLang(extname(file).slice(1));
    const rel = relative(scanRoot, file) || file;
    const seeds = scanText({ path: rel, text, lang, detectors: rules.detectors, methodologyById: rules.methodologyById });
    allSeeds.push(...seeds);
  }

  const minRank = CONF_ORDER[args.minConfidence] ?? 1;
  let ranked = rankSeeds(allSeeds).filter((s) => (CONF_ORDER[s.confidence] ?? 1) >= minRank);
  if (args.section) {
    const letter = args.section.toUpperCase();
    ranked = ranked.filter((s) => s.section.toUpperCase().startsWith(`${letter}.`));
  }
  ranked = ranked.slice(0, args.limit);
  return { root, rules, scanRoot, files, scanned, ranked };
}

function printTable(ranked) {
  if (ranked.length === 0) {
    console.log("No seeds survived the filter. Log the empty result (item 100) and move to the next fresh target.");
    return;
  }
  console.table(ranked.map((s) => ({
    conf: s.confidence,
    pri: s.priority,
    item: s.item,
    seed: s.title.length > 42 ? `${s.title.slice(0, 41)}…` : s.title,
    where: `${s.path}:${s.line}`,
  })));
  console.log(`\n${ranked.length} seed(s). These are candidates, not findings — run each through Q1 before reporting.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(import.meta.dirname, "..");

  if (args.liveCheck.length > 0) {
    const config = await loadEngagementConfig(root);
    const { key, engagement } = resolveEngagement(config, args.engagement);
    let denied = false;
    for (const target of args.liveCheck) {
      const r = checkTarget(target, engagement);
      if (r.decision === "deny") denied = true;
      const rule = r.matchedRule ? `  (${r.matchedRule})` : "";
      console.log(`[${r.decision === "allow" ? "ALLOW" : "DENY "}] ${target}  →  ${r.reason}${rule}  [engagement: ${key}]`);
    }
    process.exitCode = denied ? 1 : 0;
    return;
  }

  if (args.coverage) {
    const rules = await loadRules(root);
    const cov = computeCoverage(rules);
    console.log(`Methodology coverage: ${cov.automatedItems}/${cov.totalItems} items have an automated SRC seed.\n`);
    console.log(`Automated item ids: ${cov.automatedIds.join(", ")}\n`);
    console.log(`Handed to the live/manual lane (${cov.manualItems}):`);
    for (const item of cov.manual) {
      console.log(`  ${String(item.id).padStart(3)} [${item.lane} ${item.priority}] ${item.title}`);
    }
    return;
  }

  const { rules, scanRoot, scanned, ranked } = await runScan(args);
  const summary = summarize(ranked);
  const cov = computeCoverage(rules);
  const config = await loadEngagementConfig(root).catch(() => ({}));
  const { key } = resolveEngagement(config, args.engagement);
  const meta = { engagement: key, path: relative(root, scanRoot) || ".", filesScanned: scanned, now: new Date().toISOString() };

  if (args.report) {
    const md = renderMarkdown({ seeds: ranked, summary, coverage: cov, meta });
    await writeFile(resolve(process.cwd(), args.report), md, "utf8");
    console.log(`Wrote ${ranked.length} seed(s) to ${args.report}`);
  }

  if (args.format === "json") {
    process.stdout.write(`${JSON.stringify({ meta, summary, coverage: cov, seeds: ranked }, null, 2)}\n`);
  } else if (args.format === "ndjson") {
    process.stdout.write(`${ranked.map((s) => JSON.stringify(s)).join("\n")}\n`);
  } else if (args.format === "md") {
    if (!args.report) process.stdout.write(`${renderMarkdown({ seeds: ranked, summary, coverage: cov, meta })}\n`);
  } else {
    printTable(ranked);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`audit failed: ${error.message}`);
    process.exitCode = 1;
  });
}

export { walk, parseArgs };

// INGEST — step 1 of the hybrid loop.
//
// Locate the in-scope target *on local disk* (clone it locally when only a git
// URL is given), detect its stack(s), and produce a bounded, stack-tagged list
// of source files for the hypothesis step. Cloning a public/in-scope repo to a
// local workdir is local-analysis preparation; the tool never reaches a live
// third-party system here.

import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readTextSafe, runCommand, sha256, walkFiles } from "./io.mjs";

// Extension → stack. A file can only seed hypotheses for its own stack.
const EXTENSION_STACK = new Map([
  [".sol", "solidity"],
  [".ts", "js-ts"],
  [".tsx", "js-ts"],
  [".mts", "js-ts"],
  [".cts", "js-ts"],
  [".js", "js-ts"],
  [".jsx", "js-ts"],
  [".mjs", "js-ts"],
  [".cjs", "js-ts"],
  [".py", "python"],
  [".pyi", "python"],
  [".php", "php"],
  [".phtml", "php"],
  [".go", "go"],
]);

// Marker files add weight so a repo with config but few sources still classifies.
const MARKER_STACK = new Map([
  ["foundry.toml", "solidity"],
  ["hardhat.config.js", "solidity"],
  ["hardhat.config.ts", "solidity"],
  ["remappings.txt", "solidity"],
  ["truffle-config.js", "solidity"],
  ["package.json", "js-ts"],
  ["tsconfig.json", "js-ts"],
  ["requirements.txt", "python"],
  ["pyproject.toml", "python"],
  ["setup.py", "python"],
  ["Pipfile", "python"],
  ["composer.json", "php"],
  ["go.mod", "go"],
]);

export function extensionOf(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

export function stackOfFile(path) {
  return EXTENSION_STACK.get(extensionOf(path)) ?? null;
}

// Score each stack from source-file counts (capped) plus marker-file bonuses,
// then rank. Returns { primary, stacks: [{stack, score, files}], counts }.
export function detectStack(files, { forced = "auto" } = {}) {
  const counts = Object.create(null);
  const sourceFiles = Object.create(null);
  for (const stack of ["solidity", "js-ts", "python", "php", "go"]) {
    counts[stack] = 0;
    sourceFiles[stack] = 0;
  }

  for (const file of files) {
    const path = typeof file === "string" ? file : file.path;
    const stack = stackOfFile(path);
    if (stack) {
      counts[stack] += 1;
      sourceFiles[stack] += 1;
    }
    const base = path.slice(path.lastIndexOf("/") + 1);
    const marker = MARKER_STACK.get(base);
    if (marker) counts[marker] += 25;
  }

  let ranked = Object.entries(counts)
    .filter(([, score]) => score > 0)
    .map(([stack, score]) => ({ stack, score, files: sourceFiles[stack] }))
    .sort((a, b) => b.score - a.score || a.stack.localeCompare(b.stack));

  if (forced && forced !== "auto") {
    const forcedEntry = ranked.find((entry) => entry.stack === forced) ?? { stack: forced, score: 0, files: sourceFiles[forced] ?? 0 };
    ranked = [forcedEntry, ...ranked.filter((entry) => entry.stack !== forced)];
    return { primary: forced, stacks: ranked, counts, forced: true };
  }

  return { primary: ranked[0]?.stack ?? null, stacks: ranked, counts, forced: false };
}

async function pathExists(path) {
  return Boolean(await stat(path).catch(() => null));
}

// Clone a git URL to a deterministic local workdir. Local clone only — no
// third-party runtime access. Returns the absolute clone path.
export async function cloneTargetLocally(gitUrl, { root, ref = "", depth = 1 } = {}) {
  const workRoot = resolve(root, ".verify-loop", "targets");
  const dest = join(workRoot, sha256(gitUrl).slice(0, 16));
  if (await pathExists(join(dest, ".git"))) {
    return { path: dest, cloned: false };
  }
  const args = ["clone", "--quiet"];
  if (depth && !ref) args.push("--depth", String(depth));
  args.push(gitUrl, dest);
  const result = await runCommand("git", args, { timeoutMs: 300_000 });
  if (!result.ok) {
    throw new Error(`git clone failed for ${gitUrl}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
  }
  if (ref) {
    await runCommand("git", ["-C", dest, "fetch", "--quiet", "origin", ref], { timeoutMs: 120_000 });
    await runCommand("git", ["-C", dest, "checkout", "--quiet", ref], { timeoutMs: 60_000 });
  }
  return { path: dest, cloned: true };
}

// Resolve the local target path from config: an existing repoPath, else clone
// target.gitUrl. Throws a clear error when neither is usable.
export async function resolveTargetPath(config, { root }) {
  const repoPath = config.target?.repoPath ? resolve(root, config.target.repoPath) : "";
  if (repoPath) {
    if (!(await pathExists(repoPath))) throw new Error(`target.repoPath does not exist: ${repoPath}`);
    return { path: repoPath, cloned: false };
  }
  if (config.target?.gitUrl) {
    return cloneTargetLocally(config.target.gitUrl, { root, ref: config.target.ref });
  }
  throw new Error("no target: set target.repoPath or target.gitUrl (or pass --target <path>)");
}

// Full ingest: resolve path → detect stack → walk + read scoped source files.
// Files are tagged with their stack and their text is loaded once (bounded) so
// the hypothesis step does not re-read disk.
export async function ingest(config, { root }) {
  const target = await resolveTargetPath(config, { root });
  const walked = await walkFiles(target.path, { maxFiles: config.maxFiles, maxFileBytes: config.maxFileBytes });
  const detection = detectStack(walked, { forced: config.stack });

  const activeStacks = config.stack && config.stack !== "auto"
    ? [config.stack]
    : detection.stacks.map((entry) => entry.stack);

  const sources = [];
  for (const file of walked) {
    const stack = stackOfFile(file.path);
    if (!stack || !activeStacks.includes(stack)) continue;
    const text = await readTextSafe(file.absolute, config.maxFileBytes);
    if (text == null) continue;
    sources.push({ path: file.path, absolute: file.absolute, stack, text });
  }

  return {
    targetPath: target.path,
    cloned: target.cloned,
    detection,
    activeStacks,
    fileCount: walked.length,
    sources,
  };
}

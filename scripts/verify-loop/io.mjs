// Shared I/O, process, and filesystem helpers for the verify-loop module.
//
// The verify-loop keeps the same zero-dependency, node-built-in posture as the
// rest of the ScoutIQ pipeline (see scripts/collect.mjs): atomic JSON writes,
// bounded subprocess execution, and defensive reads that never throw on a
// missing optional file.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

export async function readTextSafe(path, maxBytes = Infinity) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    if (info.size > maxBytes) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

const DEFAULT_IGNORES = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  "lib",
  "artifacts",
  "cache",
  "target",
  "venv",
  ".venv",
  "__pycache__",
  ".mypy_cache",
]);

// Walk a directory tree, yielding repo-relative POSIX paths for regular files.
// Binary-ish and oversized files are skipped by extension/size so the scan
// stays bounded on large targets.
export async function walkFiles(root, { ignores = DEFAULT_IGNORES, maxFiles = 4000, maxFileBytes = 1_000_000 } = {}) {
  const results = [];
  const rootResolved = resolve(root);

  async function recurse(directory) {
    if (results.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (ignores.has(entry.name)) continue;
        await recurse(full);
      } else if (entry.isFile()) {
        let info;
        try {
          info = await stat(full);
        } catch {
          continue;
        }
        if (info.size > maxFileBytes) continue;
        const rel = relative(rootResolved, full).split(sep).join("/");
        results.push({ path: rel, absolute: full, size: info.size });
      }
    }
  }

  await recurse(rootResolved);
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

// Run a command with a hard timeout. Never throws: a missing binary, a timeout,
// or a non-zero exit are all reported through the resolved object so callers can
// branch on `ok`/`timedOut`/`code` instead of catching.
export function runCommand(command, args = [], { cwd, timeoutMs = 240_000, env, input, maxBuffer = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolvePromise({ ok: false, code: null, signal: null, stdout: "", stderr: String(error?.message ?? error), timedOut: false, spawnError: true });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < maxBuffer) stdout += chunk.toString("utf8");
      else truncated = true;
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < maxBuffer) stderr += chunk.toString("utf8");
      else truncated = true;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ok: false, code: null, signal: null, stdout, stderr: stderr || String(error?.message ?? error), timedOut, spawnError: true, truncated });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ok: code === 0 && !timedOut, code, signal, stdout, stderr, timedOut, spawnError: false, truncated });
    });

    if (input != null) {
      try {
        child.stdin?.write(input);
      } catch {
        // ignore broken pipe
      }
    }
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
  });
}

// Resolve a binary to an absolute path without throwing. Honors an explicit
// override (from config.tools.<id>) first, then PATH via `command -v`.
export async function which(binary, override) {
  if (override) {
    const info = await stat(override).catch(() => null);
    if (info?.isFile()) return override;
  }
  // `command` is a shell builtin with no executable of its own, so spawning it
  // directly throws ENOENT and every probe returns null. Run it through a shell.
  // Only probe well-formed binary names/paths; never interpolate arbitrary text
  // into the shell command string.
  if (typeof binary !== "string" || !/^[A-Za-z0-9._+\/-]+$/.test(binary)) return null;
  const probe = process.platform === "win32"
    ? await runCommand("where", [binary], { timeoutMs: 5_000 })
    : await runCommand("sh", ["-c", `command -v -- ${binary}`], { timeoutMs: 5_000 });
  const first = probe.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return probe.ok && first ? first : null;
}

export function truncate(text, max = 4_000) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]` : value;
}

export { dirname, join, relative, resolve };

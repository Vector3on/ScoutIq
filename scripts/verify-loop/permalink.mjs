// Commit-pinned source permalinks for confirmed findings.
//
// Every emitted finding points at exact source on a specific commit so a human
// reviewer lands on the same bytes the tools confirmed, not a moving branch tip.

import { runCommand } from "./io.mjs";

// Normalize a git remote URL (git@host:owner/repo.git, ssh://, https://, with or
// without a trailing .git) into a browsable https base: https://host/owner/repo
export function normalizeRemote(remote) {
  if (!remote) return null;
  let value = String(remote).trim();
  if (!value) return null;
  value = value.replace(/\.git$/i, "");

  const scp = value.match(/^[a-z0-9._-]+@([^:]+):(.+)$/i);
  if (scp) return `https://${scp[1]}/${scp[2].replace(/^\/+/, "")}`;

  const ssh = value.match(/^ssh:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  if (ssh) return `https://${ssh[1]}/${ssh[2].replace(/^\/+/, "")}`;

  const http = value.match(/^https?:\/\/(?:[^@]+@)?(.+)$/i);
  if (http) return `https://${http[1]}`;

  return null;
}

// Pick the blob-path fragment for the host family. GitHub/GitLab use /blob/,
// Bitbucket uses /src/. Default to GitHub's form.
function blobFragment(base) {
  if (/bitbucket\./i.test(base)) return "src";
  return "blob";
}

export function buildPermalink({ base, ref, path, line }) {
  if (!base || !ref || !path) return null;
  const cleanBase = base.replace(/\/+$/, "");
  const cleanPath = String(path).replace(/^\/+/, "");
  const anchor = Number.isFinite(Number(line)) && Number(line) > 0 ? `#L${Math.trunc(Number(line))}` : "";
  return `${cleanBase}/${blobFragment(cleanBase)}/${ref}/${cleanPath}${anchor}`;
}

// Resolve { base, ref } for a local clone. An explicit config.target.permalinkBase
// and/or config.target.ref always win; otherwise we read the git remote and HEAD.
export async function resolveCommitContext(repoPath, { permalinkBase = "", ref = "" } = {}) {
  let base = normalizeRemote(permalinkBase) || (permalinkBase ? String(permalinkBase).replace(/\/+$/, "") : null);
  let resolvedRef = ref || null;
  let remoteUrl = null;
  let dirty = false;

  if (!base) {
    const remote = await runCommand("git", ["-C", repoPath, "config", "--get", "remote.origin.url"], { timeoutMs: 5_000 });
    if (remote.ok) {
      remoteUrl = remote.stdout.trim();
      base = normalizeRemote(remoteUrl);
    }
  }

  if (!resolvedRef) {
    const head = await runCommand("git", ["-C", repoPath, "rev-parse", "HEAD"], { timeoutMs: 5_000 });
    if (head.ok) resolvedRef = head.stdout.trim();
  }

  const status = await runCommand("git", ["-C", repoPath, "status", "--porcelain"], { timeoutMs: 5_000 });
  if (status.ok && status.stdout.trim().length > 0) dirty = true;

  return { base, ref: resolvedRef, remoteUrl, dirty };
}

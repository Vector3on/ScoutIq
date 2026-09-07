// plugins/bounty/enrich.mjs — scoped, read-only enrichment of GitHub source assets.
//
// A source-available asset's findability depends on how fresh its code is, but the
// feed carries no repo internals, so ScoutIq's freshCodeIndex is 0 until we look.
// This reads the PUBLIC GitHub API (repo metadata + recent commits, + a best-effort
// files-added-on-HEAD via compare) and builds an ev-core `repoSignals` so
// evaluateTarget() computes a real freshCodeIndex — genuinely fresh source-available
// code then rises.
//
// Observe-only and legitimate: it reads public repo metadata (OSINT of the source),
// never the bounty target's live service. Anonymous (no credentials in the loop),
// GET-only, rate-limited by the manifest; a 401/403/429 is a stop signal the policy
// layer turns into a host block, and we stop enriching for the run.
const DAY = 86400000;

export function parseGithubRepo(url) {
  const m = /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(String(url ?? ''));
  if (!m) return null;
  // owner/repo only — never a deeper path (we read repo metadata, not a target path)
  if (['orgs', 'users', 'sponsors', 'about', 'topics', 'collections'].includes(m[1].toLowerCase())) return null;
  return `${m[1]}/${m[2]}`;
}

/**
 * @param fetch policy-guarded fetch → { ok, status, text, json(), headers, blocked }
 * @returns { repoSignals, revision, committedAt, branch, blocked, status }
 *          repoSignals is null when the repo could not be read (EV then falls back to unenriched).
 */
export async function enrichGithubRepo(fetch, repo, now = Date.now()) {
  const h = { headers: { accept: 'application/vnd.github+json' } };
  const meta = await fetch(`https://api.github.com/repos/${repo}`, h);
  if (!meta.ok) return { repoSignals: null, blocked: !!meta.blocked, status: meta.status };
  let m; try { m = meta.json(); } catch { return { repoSignals: null }; }
  if (m.archived) return { repoSignals: { status: 'ok', commits90d: 0, filesAdded90d: 0, archived: 1, fullName: repo }, revision: null };
  const branch = m.default_branch || 'main';
  const sinceIso = new Date(now - 90 * DAY).toISOString();

  const cRes = await fetch(`https://api.github.com/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=100&since=${encodeURIComponent(sinceIso)}`, h);
  if (cRes.blocked) return { repoSignals: null, blocked: true };
  let commits90d = 0, revision = null, oldest = null, committedAt = null;
  if (cRes.ok) { let arr; try { arr = cRes.json(); } catch { arr = []; }
    if (Array.isArray(arr) && arr.length) { commits90d = arr.length; revision = arr[0]?.sha ?? null; committedAt = arr[0]?.commit?.committer?.date ?? null; oldest = arr[arr.length - 1]?.sha ?? null; } }

  // best-effort files-added on the pinned revision (compare oldest-in-window → HEAD)
  let filesAdded90d = 0;
  if (revision && oldest && oldest !== revision) {
    try {
      const cmp = await fetch(`https://api.github.com/repos/${repo}/compare/${oldest}...${revision}`, h);
      if (cmp.blocked) return { repoSignals: buildSignals(repo, branch, m, commits90d, 0), revision, committedAt, branch, blocked: true };
      if (cmp.ok) { const j = cmp.json(); filesAdded90d = (j.files ?? []).filter((f) => f.status === 'added').length; }
    } catch { /* compare is best-effort */ }
  }
  return { repoSignals: buildSignals(repo, branch, m, commits90d, filesAdded90d), revision, committedAt, branch, blocked: false };
}

function buildSignals(repo, branch, m, commits90d, filesAdded90d) {
  return {
    status: 'ok', fullName: repo, defaultBranch: branch,
    commits90d, filesAdded90d, maxMergedPrAdditions90d: 0,
    stars: Number(m.stargazers_count) || 0, ageY: m.created_at ? (Date.now() - Date.parse(m.created_at)) / (365 * DAY) : 0,
    pushedAt: m.pushed_at ?? null, archived: m.archived ? 1 : 0,
    languages: m.language ? { [String(m.language).toLowerCase()]: 1 } : {},
  };
}

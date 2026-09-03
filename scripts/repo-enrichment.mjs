import { createHash } from "node:crypto";

const DAY = 86_400_000;
const FUZZ_PATH = /(^|\/)(oss-fuzz[^/]*|fuzz(?:ing|ers?)?)(\/|$)|(^|\/)[^/]*(?:_fuzz\.|fuzz[^/]*\.)/i;
const FUZZ_FUNCTION = /\b(?:func\s+Fuzz[A-Za-z0-9_]*|Fuzz[A-Za-z0-9_]*\s*\(|LLVMFuzzerTestOneInput\s*\()/;
const TEST_PATH = /(^|\/)(?:test|tests|spec|specs)(?:\/|_|\.)/i;
const DEV_KNOWN_FILENAME = /(replay|exploit|poc|vuln|security[_-]?test)/i;
const DEV_KNOWN_COMMENT = /(documents? the vulnerability|known issue|do not use in production|not.{0,10}secure)/i;
const DISABLED_FLAG = /(if\s*\(?\s*false\b|math\.MaxInt64|max_int64|feature.{0,40}(?:disabled|false)|fork.{0,40}(?:never|disabled|max))/i;
const SECURITY_CONTEXT = /(security|secure|replay|exploit|vuln|attack|signature|auth)/i;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function isoBefore(now, days) {
  return new Date(new Date(now).getTime() - days * DAY).toISOString();
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function parseLastPage(link) {
  if (!link) return null;
  const match = String(link).match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/i);
  return match ? Number(match[1]) : null;
}

export function parseRepositoryTarget(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const scp = raw.match(/^git@(github\.com|gitlab\.com):(.+?)(?:\.git)?$/i);
  let host;
  let path;
  if (scp) {
    host = scp[1].toLowerCase();
    path = scp[2];
  } else {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return null;
    }
    host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "github.com" && host !== "gitlab.com") return null;
    path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, "");
  }

  let parts = path.split("/").filter(Boolean);
  const marker = parts.indexOf("-");
  if (marker >= 0) parts = parts.slice(0, marker);
  const stop = parts.findIndex((part) => ["tree", "blob", "commit", "issues", "pull", "releases"].includes(part));
  if (stop >= 0) parts = parts.slice(0, stop);
  if (parts.length < 2) return null;
  if (host === "github.com") parts = parts.slice(0, 2);
  parts[parts.length - 1] = parts.at(-1).replace(/\.git$/i, "");
  const fullName = parts.join("/");
  return {
    provider: host === "github.com" ? "github" : "gitlab",
    host,
    owner: host === "github.com" ? parts[0] : parts.slice(0, -1).join("/"),
    name: parts.at(-1),
    fullName,
    key: `${host === "github.com" ? "github" : "gitlab"}:${fullName.toLowerCase()}`,
    url: `https://${host}/${fullName}`,
  };
}

async function requestJson(url, options = {}) {
  const headers = {
    accept: "application/json",
    "user-agent": "ScoutIQ/2.0 repo-enrichment",
    ...(options.headers ?? {}),
  };
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body,
    signal: AbortSignal.timeout(options.timeoutMs ?? 25_000),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  if (!response.ok) {
    const message = typeof payload === "object" ? payload?.message : payload;
    const error = new Error(`${response.status} ${message ?? response.statusText}`.slice(0, 240));
    error.status = response.status;
    error.remaining = number(response.headers.get("x-ratelimit-remaining"), null);
    throw error;
  }
  return { payload, headers: response.headers, status: response.status };
}

function githubHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function githubGraphql(ref, token, now, fetchImpl) {
  const query = `query ScoutRepo($owner: String!, $name: String!, $since7: GitTimestamp!, $since30: GitTimestamp!, $since90: GitTimestamp!, $prQuery: String!) {
    repository(owner: $owner, name: $name) {
      nameWithOwner createdAt pushedAt stargazerCount forkCount isArchived
      defaultBranchRef { name target { ... on Commit {
        commits7: history(since: $since7) { totalCount }
        commits30: history(since: $since30) { totalCount }
        commits90: history(since: $since90) { totalCount }
      } } }
      releases { totalCount }
      languages(first: 20, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name } } }
    }
    merged: search(type: ISSUE, query: $prQuery, first: 100) {
      issueCount nodes { ... on PullRequest { additions mergedAt } }
    }
  }`;
  const variables = {
    owner: ref.owner,
    name: ref.name,
    since7: isoBefore(now, 7),
    since30: isoBefore(now, 30),
    since90: isoBefore(now, 90),
    prQuery: `repo:${ref.fullName} is:pr is:merged merged:>=${isoBefore(now, 90).slice(0, 10)}`,
  };
  const response = await requestJson("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...githubHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    fetchImpl,
  });
  if (response.payload?.errors?.length) throw new Error(response.payload.errors.map((item) => item.message).join("; ").slice(0, 240));
  return response.payload?.data ?? {};
}

async function githubRest(path, token, fetchImpl, query = "") {
  return requestJson(`https://api.github.com${path}${query}`, {
    headers: githubHeaders(token),
    fetchImpl,
  });
}

function topTwoTree(tree) {
  const paths = tree
    .map((item) => String(item.path ?? ""))
    .filter((path) => path && path.split("/").length <= 2)
    .sort();
  return { paths: paths.slice(0, 2000), truncated: paths.length > 2000 };
}

function candidatePaths(tree) {
  const preferred = tree
    .filter((item) => item.type === "blob" && number(item.size) <= 250_000)
    .map((item) => String(item.path))
    .filter((path) =>
      /(^|\/)security\.md$/i.test(path)
      || /^\.github\/workflows\/.*\.ya?ml$/i.test(path)
      || FUZZ_PATH.test(path)
      || TEST_PATH.test(path) && DEV_KNOWN_FILENAME.test(path)
      || /(feature|fork|security|replay).{0,30}\.(go|rs|c|cc|cpp|h|hpp|js|ts|py|java|kt|toml|ya?ml)$/i.test(path),
    );
  return [...new Set(preferred)].slice(0, 24);
}

export function detectRepositorySignals(tree = [], scannedFiles = []) {
  const paths = tree.map((item) => typeof item === "string" ? item : String(item.path ?? "")).filter(Boolean);
  const securityMd = paths.some((path) => /(^|\/)security\.md$/i.test(path));
  const fuzzPath = paths.some((path) => FUZZ_PATH.test(path));
  const workflowPaths = paths.filter((path) => /^\.github\/workflows\/.*\.ya?ml$/i.test(path));
  const suspiciousTestFiles = paths.filter((path) => TEST_PATH.test(path) && DEV_KNOWN_FILENAME.test(path));
  const tooling = new Set();
  const trapHits = [];
  let fuzzFunction = false;
  let securityFixGated = false;

  for (const file of scannedFiles) {
    const path = String(file.path ?? "");
    const text = String(file.text ?? "").slice(0, 500_000);
    for (const match of text.matchAll(/codeql|semgrep|snyk|trivy/gi)) tooling.add(match[0].toLowerCase());
    if (FUZZ_FUNCTION.test(text)) fuzzFunction = true;
    if (TEST_PATH.test(path) && DEV_KNOWN_FILENAME.test(path)) trapHits.push({ type: "test-filename", path });
    if (DEV_KNOWN_COMMENT.test(text)) trapHits.push({ type: "known-comment", path });
    if (DISABLED_FLAG.test(text) && SECURITY_CONTEXT.test(text)) {
      trapHits.push({ type: "disabled-security-flag", path });
      securityFixGated = true;
    }
  }
  for (const path of suspiciousTestFiles) trapHits.push({ type: "test-filename", path });

  const uniqueTraps = [...new Map(trapHits.map((item) => [`${item.type}:${item.path}`, item])).values()].slice(0, 20);
  return {
    securityMd,
    fuzzPath,
    fuzzFunction,
    securityWorkflows: [...tooling].sort(),
    workflowPaths,
    secTooling: securityMd || fuzzPath || fuzzFunction || tooling.size > 0,
    trapHits: uniqueTraps,
    trapTags: uniqueTraps.length ? ["DEV_KNOWN"] : [],
    devKnown: uniqueTraps.length > 0,
    securityFixGated,
  };
}

async function scanGithubFiles(ref, branch, paths, token, fetchImpl) {
  const results = [];
  for (const path of paths) {
    try {
      const response = await (fetchImpl ?? fetch)(
        `https://raw.githubusercontent.com/${encodePath(ref.fullName)}/${encodeURIComponent(branch)}/${encodePath(path)}`,
        {
          headers: { "user-agent": "ScoutIQ/2.0 repo-enrichment", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          signal: AbortSignal.timeout(12_000),
        },
      );
      if (!response.ok) continue;
      const text = await response.text();
      if (Buffer.byteLength(text) <= 500_000) results.push({ path, text });
    } catch {
      // Individual source files are optional; the tree and API data still remain useful.
    }
  }
  return results;
}

function advisorySignals(advisories, treePaths, now) {
  const cutoff = new Date(now).getTime() - 365 * DAY;
  const resolved = advisories.filter((item) => ["published", "closed"].includes(String(item.state).toLowerCase())).length;
  const open = advisories.filter((item) => ["open", "draft", "triage"].includes(String(item.state).toLowerCase())).length;
  const recentOpen = advisories.filter((item) => {
    const timestamp = new Date(item.updated_at ?? item.published_at ?? item.created_at).getTime();
    return ["open", "draft", "triage"].includes(String(item.state).toLowerCase()) && timestamp >= cutoff;
  });
  const treeText = treePaths.join(" ").toLowerCase();
  const pathMatch = recentOpen.some((item) => (item.vulnerabilities ?? []).some((vulnerability) => {
    const packageName = String(vulnerability.package?.name ?? "").toLowerCase();
    return packageName.length > 2 && treeText.includes(packageName);
  }));
  return { open, resolved, total: advisories.length, recent: recentOpen.length, pathMatch };
}

export async function enrichGithubRepository(ref, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const token = options.token ?? process.env.GITHUB_TOKEN ?? "";
  const fetchImpl = options.fetchImpl;
  const graph = await githubGraphql(ref, token, now, fetchImpl);
  const repo = graph.repository;
  if (!repo) throw new Error("repository not found or inaccessible");
  const branch = repo.defaultBranchRef?.name;
  if (!branch) throw new Error("repository has no default branch");
  const basePath = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;

  const [treeResponse, contributorsResponse, advisoriesResponse, baseCommitResponse] = await Promise.all([
    githubRest(`${basePath}/git/trees/${encodeURIComponent(branch)}`, token, fetchImpl, "?recursive=1"),
    githubRest(`${basePath}/contributors`, token, fetchImpl, "?per_page=1&anon=1"),
    githubRest(`${basePath}/security-advisories`, token, fetchImpl, "?per_page=100").catch((error) => ({ payload: [], advisoryError: error.message })),
    githubRest(`${basePath}/commits`, token, fetchImpl, `?until=${encodeURIComponent(isoBefore(now, 90))}&per_page=1`).catch(() => ({ payload: [] })),
  ]);

  const tree = Array.isArray(treeResponse.payload?.tree) ? treeResponse.payload.tree : [];
  const baseSha = baseCommitResponse.payload?.[0]?.sha;
  let compare = null;
  if (baseSha) {
    compare = await githubRest(
      `${basePath}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(branch)}`,
      token,
      fetchImpl,
      "?per_page=100",
    ).then((result) => result.payload).catch(() => null);
  }
  const scanPaths = candidatePaths(tree);
  const scannedFiles = await scanGithubFiles(ref, branch, scanPaths, token, fetchImpl);
  const detected = detectRepositorySignals(tree, scannedFiles);
  const top = topTwoTree(tree);
  const files = Array.isArray(compare?.files) ? compare.files : [];
  const filesAdded = files.filter((file) => file.status === "added").map((file) => file.filename).sort();
  const advisories = Array.isArray(advisoriesResponse.payload) ? advisoriesResponse.payload : [];
  const advisory = advisorySignals(advisories, tree.map((item) => item.path), now);
  const contributors = parseLastPage(contributorsResponse.headers?.get("link"))
    ?? (Array.isArray(contributorsResponse.payload) ? contributorsResponse.payload.length : 0);
  const pulls = graph.merged?.nodes ?? [];
  const ageY = Math.max(0, (new Date(now).getTime() - new Date(repo.createdAt).getTime()) / (365.25 * DAY));
  const languages = Object.fromEntries((repo.languages?.edges ?? []).map((edge) => [edge.node.name.toLowerCase(), edge.size]));

  return {
    status: "ok",
    provider: "github",
    fullName: repo.nameWithOwner,
    url: ref.url,
    fetchedAt: now,
    createdAt: repo.createdAt,
    pushedAt: repo.pushedAt,
    ageY: Math.round(ageY * 10) / 10,
    stars: repo.stargazerCount,
    forks: repo.forkCount,
    contributorsCount: contributors,
    releases: repo.releases?.totalCount ?? 0,
    defaultBranch: branch,
    archived: Boolean(repo.isArchived),
    languages,
    treeTop2: top.paths,
    treeTruncated: Boolean(treeResponse.payload?.truncated) || top.truncated,
    commits7d: repo.defaultBranchRef?.target?.commits7?.totalCount ?? 0,
    commits30d: repo.defaultBranchRef?.target?.commits30?.totalCount ?? 0,
    commits90d: repo.defaultBranchRef?.target?.commits90?.totalCount ?? 0,
    filesTouched90d: files.length,
    filesAdded90d: filesAdded.length,
    filesAdded90dList: filesAdded.slice(0, 300),
    files90dTruncated: files.length >= 300 || number(compare?.total_commits) > 250,
    mergedPrs90d: graph.merged?.issueCount ?? pulls.length,
    maxMergedPrAdditions90d: pulls.reduce((max, pull) => Math.max(max, number(pull.additions)), 0),
    advisories: { open: advisory.open, resolved: advisory.resolved, total: advisory.total },
    openRecentAdvisoryPathMatch: advisory.pathMatch,
    advisoryCoverage: advisoriesResponse.advisoryError ? "unavailable" : "repository-advisories",
    scanCoverage: { candidates: scanPaths.length, filesRead: scannedFiles.length },
    ...detected,
  };
}

function gitlabHeaders(token) {
  return token ? { "private-token": token } : {};
}

async function gitlabGet(ref, suffix, token, fetchImpl, query = "") {
  const project = encodeURIComponent(ref.fullName);
  return requestJson(`https://gitlab.com/api/v4/projects/${project}${suffix}${query}`, {
    headers: gitlabHeaders(token),
    fetchImpl,
  });
}

async function scanGitlabFiles(ref, branch, paths, token, fetchImpl) {
  const results = [];
  for (const path of paths.slice(0, 20)) {
    try {
      const response = await gitlabGet(ref, `/repository/files/${encodeURIComponent(path)}/raw`, token, fetchImpl, `?ref=${encodeURIComponent(branch)}`);
      if (typeof response.payload === "string") results.push({ path, text: response.payload });
    } catch {
      // Fail-soft on individual files.
    }
  }
  return results;
}

export async function enrichGitlabRepository(ref, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const token = options.token ?? process.env.GITLAB_TOKEN ?? "";
  const fetchImpl = options.fetchImpl;
  const [metadata, languages, treeResponse, commits90, commits30, commits7, mergeRequests, contributors, releases] = await Promise.all([
    gitlabGet(ref, "", token, fetchImpl),
    gitlabGet(ref, "/languages", token, fetchImpl),
    gitlabGet(ref, "/repository/tree", token, fetchImpl, "?recursive=true&per_page=100"),
    gitlabGet(ref, "/repository/commits", token, fetchImpl, `?since=${encodeURIComponent(isoBefore(now, 90))}&per_page=100`),
    gitlabGet(ref, "/repository/commits", token, fetchImpl, `?since=${encodeURIComponent(isoBefore(now, 30))}&per_page=1`),
    gitlabGet(ref, "/repository/commits", token, fetchImpl, `?since=${encodeURIComponent(isoBefore(now, 7))}&per_page=1`),
    gitlabGet(ref, "/merge_requests", token, fetchImpl, `?state=merged&updated_after=${encodeURIComponent(isoBefore(now, 90))}&per_page=100`),
    gitlabGet(ref, "/repository/contributors", token, fetchImpl, "?per_page=1"),
    gitlabGet(ref, "/releases", token, fetchImpl, "?per_page=1").catch(() => ({ payload: [], headers: new Headers() })),
  ]);
  const repo = metadata.payload;
  const branch = repo.default_branch;
  const rawTree = Array.isArray(treeResponse.payload) ? treeResponse.payload : [];
  const tree = rawTree.map((item) => ({ path: item.path, type: item.type === "blob" ? "blob" : "tree", size: 0 }));
  const recentCommits = Array.isArray(commits90.payload) ? commits90.payload.slice(0, 25) : [];
  const diffs = [];
  for (const commit of recentCommits) {
    try {
      const response = await gitlabGet(ref, `/repository/commits/${encodeURIComponent(commit.id)}/diff`, token, fetchImpl, "?per_page=100");
      if (Array.isArray(response.payload)) diffs.push(...response.payload);
    } catch {
      break;
    }
  }
  const scanPaths = candidatePaths(tree);
  const scannedFiles = await scanGitlabFiles(ref, branch, scanPaths, token, fetchImpl);
  const detected = detectRepositorySignals(tree, scannedFiles);
  const top = topTwoTree(tree);
  const added = [...new Set(diffs.filter((item) => item.new_file).map((item) => item.new_path))].sort();
  const touched = [...new Set(diffs.map((item) => item.new_path || item.old_path).filter(Boolean))];
  const mr = Array.isArray(mergeRequests.payload) ? mergeRequests.payload : [];
  const ageY = Math.max(0, (new Date(now).getTime() - new Date(repo.created_at).getTime()) / (365.25 * DAY));
  const total = (response) => number(response.headers?.get("x-total"), Array.isArray(response.payload) ? response.payload.length : 0);

  return {
    status: "ok",
    provider: "gitlab",
    fullName: ref.fullName,
    url: ref.url,
    fetchedAt: now,
    createdAt: repo.created_at,
    pushedAt: repo.last_activity_at,
    ageY: Math.round(ageY * 10) / 10,
    stars: repo.star_count ?? 0,
    forks: repo.forks_count ?? 0,
    contributorsCount: total(contributors),
    releases: total(releases),
    defaultBranch: branch,
    archived: Boolean(repo.archived),
    languages: Object.fromEntries(Object.entries(languages.payload ?? {}).map(([name, share]) => [name.toLowerCase(), share])),
    treeTop2: top.paths,
    treeTruncated: total(treeResponse) > rawTree.length || top.truncated,
    commits7d: total(commits7),
    commits30d: total(commits30),
    commits90d: total(commits90),
    filesTouched90d: touched.length,
    filesAdded90d: added.length,
    filesAdded90dList: added.slice(0, 300),
    files90dTruncated: total(commits90) > recentCommits.length,
    mergedPrs90d: total(mergeRequests),
    maxMergedPrAdditions90d: mr.reduce((max, item) => Math.max(max, number(item.changes_count)), 0),
    advisories: { open: 0, resolved: 0, total: 0 },
    advisoryCoverage: "unavailable",
    openRecentAdvisoryPathMatch: false,
    scanCoverage: { candidates: scanPaths.length, filesRead: scannedFiles.length },
    ...detected,
  };
}

function refsFromPrograms(programs) {
  const refs = new Map();
  for (const program of programs) {
    for (const target of program.targets ?? []) {
      const ref = parseRepositoryTarget(target.value);
      if (!ref) continue;
      const priority = program.change?.type === "new_target" ? 3 : program.change?.type === "new_program" ? 2 : 1;
      const existing = refs.get(ref.key);
      if (!existing || priority > existing.priority) refs.set(ref.key, { ...ref, priority });
    }
  }
  return [...refs.values()];
}

function cacheFresh(entry, now, ttlHours) {
  if (!entry?.fetchedAt || entry.status !== "ok") return false;
  const age = new Date(now).getTime() - new Date(entry.fetchedAt).getTime();
  return Number.isFinite(age) && age < ttlHours * 3_600_000;
}

export async function enrichRepositoryCache(programs, priorCache = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const budget = Math.max(0, number(options.budget, 10));
  const ttlHours = Math.max(1, number(options.ttlHours, 72));
  const repositories = { ...(priorCache.repositories ?? {}) };
  const refs = refsFromPrograms(programs).sort((a, b) => {
    const aFresh = cacheFresh(repositories[a.key], now, ttlHours);
    const bFresh = cacheFresh(repositories[b.key], now, ttlHours);
    if (aFresh !== bFresh) return aFresh ? 1 : -1;
    return b.priority - a.priority || (repositories[a.key]?.fetchedAt ?? "").localeCompare(repositories[b.key]?.fetchedAt ?? "");
  });
  let attempted = 0;
  let updated = 0;
  let failed = 0;
  let rateLimited = false;

  for (const ref of refs) {
    if (attempted >= budget || rateLimited) break;
    if (cacheFresh(repositories[ref.key], now, ttlHours)) continue;
    attempted += 1;
    try {
      const value = ref.provider === "github"
        ? await enrichGithubRepository(ref, options)
        : await enrichGitlabRepository(ref, options);
      repositories[ref.key] = value;
      updated += 1;
    } catch (error) {
      failed += 1;
      if (error?.status === 403 || error?.status === 429 || error?.remaining === 0) rateLimited = true;
      const previous = repositories[ref.key];
      repositories[ref.key] = previous?.status === "ok"
        ? { ...previous, lastErrorAt: now, lastError: String(error.message).slice(0, 180) }
        : {
          status: "pending",
          provider: ref.provider,
          fullName: ref.fullName,
          url: ref.url,
          fetchedAt: null,
          lastErrorAt: now,
          lastError: String(error.message).slice(0, 180),
          cacheKey: hash(ref.key),
        };
    }
  }

  for (const ref of refs) {
    if (!repositories[ref.key]) {
      repositories[ref.key] = {
        status: "pending",
        provider: ref.provider,
        fullName: ref.fullName,
        url: ref.url,
        fetchedAt: null,
        cacheKey: hash(ref.key),
      };
    }
  }

  return {
    cache: { version: 2, generatedAt: now, repositories },
    stats: { discovered: refs.length, attempted, updated, failed, pending: refs.filter((ref) => repositories[ref.key]?.status !== "ok").length, rateLimited },
  };
}

export function repositorySignalsFor(target, cache) {
  const ref = parseRepositoryTarget(target?.value);
  return ref ? cache?.repositories?.[ref.key] ?? { status: "pending", provider: ref.provider, fullName: ref.fullName, url: ref.url } : null;
}

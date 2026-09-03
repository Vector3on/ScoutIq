import { createHash } from "node:crypto";

const DAY = 86_400_000;
const GITHUB_METADATA_BATCH_SIZE = 100;
const GITHUB_BLOB_BATCH_SIZE = 75;
const MAX_SCAN_FILES = 400;
const MAX_SCAN_BYTES = 8_000_000;
const FUZZ_PATH = /(^|\/)(oss-fuzz[^/]*|fuzz(?:ing|ers?)?)(\/|$)|(^|\/)[^/]*(?:_fuzz\.|fuzz[^/]*\.)/i;
const FUZZ_FUNCTION = /\b(?:func\s+Fuzz[A-Za-z0-9_]*|Fuzz[A-Za-z0-9_]*\s*\(|LLVMFuzzerTestOneInput\s*\()/;
const TEST_PATH = /(^|\/)(?:test|tests|spec|specs)(?:\/|_|\.)|(?:^|\/)[^/]+(?:_test\.[^/]+|\.(?:test|spec)\.[^/]+)$/i;
const DEV_KNOWN_FILENAME = /(replay|exploit|poc|vuln|security[_-]?test)/i;
const DEV_KNOWN_COMMENT = /(?:\/\/|#|\/\*|\*|<!--|--)\s*.{0,160}?(documents? the vulnerability|known issue|do not use in production|not.{0,10}secure)/i;
const DISABLED_FLAG = /(if\s*\(?\s*false\b|math\.MaxInt64|max_int64|feature.{0,40}(?:disabled|false)|fork.{0,40}(?:never|disabled|max))/i;
const SECURITY_CONTEXT = /(security|secure|replay|exploit|vuln|attack|signature|auth)/i;
const TEXT_FILE = /(?:^|\/)(?:[^/.]+|[^/]+\.(?:md|txt|rst|adoc|go|rs|c|cc|cpp|cxx|h|hh|hpp|hxx|js|jsx|mjs|cjs|ts|tsx|py|rb|php|java|kt|kts|scala|swift|sol|move|vy|sh|bash|zsh|fish|ps1|json|jsonc|toml|ya?ml|xml|ini|cfg|conf|properties|gradle|proto|graphql|gql|sql|dockerfile|mk|cmake))$/i;
const HIGH_VALUE_SOURCE = /(priority|signature|signer|security|auth|replay|exploit|vuln|attack|fork|feature|config|transactor|nonce)/i;

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

function parseLastPage(link) {
  if (!link) return null;
  const match = String(link).match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/i);
  return match ? Number(match[1]) : null;
}

export function parseRepositoryTarget(value) {
  const raw = String(value ?? "").trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
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
  const stop = parts.findIndex((part) => ["tree", "blob", "commit", "commits", "issues", "pull", "pulls", "releases", "tags"].includes(part.toLowerCase()));
  if (stop >= 0) parts = parts.slice(0, stop);
  if (parts.length < 2) return null;
  if (host === "github.com") parts = parts.slice(0, 2);
  parts[parts.length - 1] = parts.at(-1).replace(/\.git$/i, "");
  const validPart = /^(?=.*[a-z0-9])[a-z0-9._-]+$/i;
  if (parts.some((part) => !validPart.test(part))) return null;
  const fullName = parts.join("/");
  return {
    provider: host === "github.com" ? "github" : "gitlab",
    host,
    owner: host === "github.com" ? parts[0] : parts.slice(0, -1).join("/"),
    name: parts.at(-1),
    fullName,
    key: host === "github.com" ? fullName.toLowerCase() : `gitlab.com/${fullName.toLowerCase()}`,
    url: `https://${host}/${fullName}`,
  };
}

export function resolveGithubAuth(options = {}, env = process.env) {
  const candidates = [
    ["option", options.githubToken],
    ["option", options.token],
    ["GH_PAT", env.GH_PAT],
    ["SCOUTIQ_GITHUB_TOKEN", env.SCOUTIQ_GITHUB_TOKEN],
    ["GITHUB_TOKEN", env.GITHUB_TOKEN],
  ];
  const match = candidates.find(([, value]) => typeof value === "string" && value.trim().length > 0);
  return match ? { source: match[0], token: match[1].trim() } : { source: "missing", token: "" };
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
    const remaining = response.headers.get("x-ratelimit-remaining");
    error.remaining = remaining == null ? null : number(remaining, null);
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

export function buildGithubMetadataQuery(refs) {
  if (refs.length > GITHUB_METADATA_BATCH_SIZE) throw new Error(`GitHub metadata batch exceeds ${GITHUB_METADATA_BATCH_SIZE} repositories`);
  const repositories = refs.map((ref, index) => `r${index}: repository(owner: ${JSON.stringify(ref.owner)}, name: ${JSON.stringify(ref.name)}) {
    nameWithOwner createdAt pushedAt stargazerCount forkCount isArchived
    defaultBranchRef { name }
    releases { totalCount }
    languages(first: 20, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name } } }
  }`).join("\n");
  return {
    query: `query ScoutRepoBatch {\n${repositories}\n}`,
    variables: {},
  };
}

async function githubGraphqlBatch(refs, token, now, fetchImpl) {
  const { query, variables } = buildGithubMetadataQuery(refs, now);
  const response = await requestJson("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...githubHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    fetchImpl,
  });
  const errors = response.payload?.errors ?? [];
  const values = new Map();
  refs.forEach((ref, index) => {
    const repo = response.payload?.data?.[`r${index}`] ?? null;
    const aliasErrors = errors.filter((error) => error.path?.[0] === `r${index}`).map((error) => error.message);
    values.set(ref.key, repo
      ? { status: "ok", repo }
      : { status: "error", error: (aliasErrors.join("; ") || "repository not found or inaccessible").slice(0, 240) });
  });
  return values;
}

function transientGithubGatewayError(error) {
  const status = Number(error?.status);
  return status >= 500
    || error?.name === "TimeoutError"
    || /gateway|timeout|timed out|fetch failed|econnreset|socket hang up/i.test(String(error?.message ?? error));
}

export async function githubGraphqlBatchResilient(refs, token, now, fetchImpl, logger = console, minimumBatchSize = 10) {
  try {
    return {
      values: await githubGraphqlBatch(refs, token, now, fetchImpl),
      requests: 1,
      fallbacks: 0,
    };
  } catch (error) {
    if (!transientGithubGatewayError(error)) throw error;
    if (refs.length <= minimumBatchSize) {
      const message = String(error?.message ?? error).slice(0, 240);
      logger.error?.(`[repo-enrichment] GitHub metadata batch terminal failure (${refs.length} repos): ${message}`);
      return {
        values: new Map(refs.map((ref) => [ref.key, { status: "error", error: message }])),
        requests: 1,
        fallbacks: 0,
      };
    }
    const midpoint = Math.ceil(refs.length / 2);
    const leftRefs = refs.slice(0, midpoint);
    const rightRefs = refs.slice(midpoint);
    logger.warn?.(`[repo-enrichment] GitHub metadata batch failed (${refs.length} repos): ${String(error?.message ?? error).slice(0, 160)}; retrying as ${leftRefs.length}+${rightRefs.length}`);
    const left = await githubGraphqlBatchResilient(leftRefs, token, now, fetchImpl, logger, minimumBatchSize);
    const right = await githubGraphqlBatchResilient(rightRefs, token, now, fetchImpl, logger, minimumBatchSize);
    return {
      values: new Map([...left.values, ...right.values]),
      requests: 1 + left.requests + right.requests,
      fallbacks: 1 + left.fallbacks + right.fallbacks,
    };
  }
}

async function githubRepositoryActivity(ref, token, now, fetchImpl) {
  const query = `query ScoutRepoActivity($owner: String!, $name: String!, $since7: GitTimestamp!, $since30: GitTimestamp!, $since90: GitTimestamp!) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef { target { ... on Commit {
        commits7: history(since: $since7) { totalCount }
        commits30: history(since: $since30) { totalCount }
        commits90: history(since: $since90) { totalCount }
      } } }
      pullRequests(first: 100, states: MERGED, orderBy: {field: UPDATED_AT, direction: DESC}) {
        nodes { additions mergedAt }
      }
    }
  }`;
  const response = await requestJson("https://api.github.com/graphql", {
    method: "POST",
    headers: { ...githubHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({
      query,
      variables: {
        owner: ref.owner,
        name: ref.name,
        since7: isoBefore(now, 7),
        since30: isoBefore(now, 30),
        since90: isoBefore(now, 90),
      },
    }),
    fetchImpl,
  });
  const repository = response.payload?.data?.repository;
  if (!repository) {
    const message = (response.payload?.errors ?? []).map((error) => error.message).join("; ");
    throw new Error((message || "repository activity unavailable").slice(0, 240));
  }
  return repository;
}

function pagedCount(response) {
  if (!response) return null;
  return parseLastPage(response.headers?.get("link"))
    ?? (Array.isArray(response.payload) ? response.payload.length : null);
}

async function githubActivityRestFallback(basePath, token, now, fetchImpl) {
  const safe = (promise) => promise.catch(() => null);
  const [commits7, commits30, commits90, pullsResponse] = await Promise.all([
    safe(githubRest(`${basePath}/commits`, token, fetchImpl, `?since=${encodeURIComponent(isoBefore(now, 7))}&per_page=1`)),
    safe(githubRest(`${basePath}/commits`, token, fetchImpl, `?since=${encodeURIComponent(isoBefore(now, 30))}&per_page=1`)),
    safe(githubRest(`${basePath}/commits`, token, fetchImpl, `?since=${encodeURIComponent(isoBefore(now, 90))}&per_page=1`)),
    safe(githubRest(`${basePath}/pulls`, token, fetchImpl, "?state=closed&sort=updated&direction=desc&per_page=100")),
  ]);
  const cutoff90 = new Date(isoBefore(now, 90)).getTime();
  const pulls = (Array.isArray(pullsResponse?.payload) ? pullsResponse.payload : [])
    .filter((pull) => pull.merged_at && new Date(pull.merged_at).getTime() >= cutoff90);
  return {
    commits7d: pagedCount(commits7),
    commits30d: pagedCount(commits30),
    commits90d: pagedCount(commits90),
    mergedPrs90d: pullsResponse ? pulls.length : null,
    maxMergedPrAdditions90d: null,
    mergedPrs90dTruncated: (pullsResponse?.payload?.length ?? 0) === 100,
  };
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

function scanPriority(path) {
  if (TEST_PATH.test(path) && DEV_KNOWN_FILENAME.test(path.split("/").at(-1))) return 0;
  if (/^\.github\/workflows\/.*\.ya?ml$/i.test(path) || /(^|\/)security\.md$/i.test(path) || FUZZ_PATH.test(path)) return 0;
  if (HIGH_VALUE_SOURCE.test(path)) return 1;
  if (TEST_PATH.test(path)) return 2;
  return 4;
}

export function selectScanBlobs(tree, options = {}) {
  const maxFiles = Math.max(1, number(options.maxFiles, MAX_SCAN_FILES));
  const maxBytes = Math.max(1, number(options.maxBytes, MAX_SCAN_BYTES));
  const eligible = tree
    .filter((item) => item.type === "blob" && item.sha && number(item.size, maxBytes + 1) <= 500_000)
    .filter((item) => TEXT_FILE.test(String(item.path ?? "")))
    .sort((a, b) => scanPriority(String(a.path)) - scanPriority(String(b.path)) || number(a.size) - number(b.size) || String(a.path).localeCompare(String(b.path)));
  const selected = [];
  let bytes = 0;
  for (const item of eligible) {
    const size = number(item.size);
    if (selected.length >= maxFiles || bytes + size > maxBytes) continue;
    selected.push({ path: String(item.path), sha: String(item.sha), size });
    bytes += size;
  }
  return { selected, eligibleCount: eligible.length, selectedBytes: bytes, complete: selected.length === eligible.length };
}

export function detectRepositorySignals(tree = [], scannedFiles = []) {
  const paths = tree.map((item) => typeof item === "string" ? item : String(item.path ?? "")).filter(Boolean);
  const securityMd = paths.some((path) => /(^|\/)security\.md$/i.test(path));
  const fuzzPath = paths.some((path) => FUZZ_PATH.test(path));
  const workflowPaths = paths.filter((path) => /^\.github\/workflows\/.*\.ya?ml$/i.test(path));
  const suspiciousTestFiles = paths.filter((path) => TEST_PATH.test(path) && DEV_KNOWN_FILENAME.test(path.split("/").at(-1)));
  const tooling = new Set();
  const trapHits = [];
  let fuzzFunction = false;
  let securityFixGated = false;

  for (const path of workflowPaths) {
    for (const match of path.matchAll(/codeql|semgrep|snyk|trivy/gi)) tooling.add(match[0].toLowerCase());
  }

  for (const file of scannedFiles) {
    const path = String(file.path ?? "");
    const text = String(file.text ?? "").slice(0, 500_000);
    for (const match of text.matchAll(/codeql|semgrep|snyk|trivy/gi)) tooling.add(match[0].toLowerCase());
    if (FUZZ_FUNCTION.test(text)) fuzzFunction = true;
    if (TEST_PATH.test(path) && DEV_KNOWN_FILENAME.test(path.split("/").at(-1))) {
      trapHits.push({ type: "test-filename", path, match: path.split("/").at(-1) });
    }
    const commentMatch = DEV_KNOWN_COMMENT.exec(text);
    if (commentMatch) {
      trapHits.push({
        type: "known-comment",
        path,
        line: text.slice(0, commentMatch.index).split("\n").length,
        match: commentMatch[0].replace(/\s+/g, " ").trim().slice(0, 180),
      });
    }
    const disabledMatch = DISABLED_FLAG.exec(text);
    if (disabledMatch && SECURITY_CONTEXT.test(text)) {
      trapHits.push({
        type: "disabled-security-flag",
        path,
        line: text.slice(0, disabledMatch.index).split("\n").length,
        match: disabledMatch[0].replace(/\s+/g, " ").trim().slice(0, 180),
      });
      securityFixGated = true;
    }
  }
  for (const path of suspiciousTestFiles) trapHits.push({ type: "test-filename", path, match: path.split("/").at(-1) });

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

async function scanGithubFiles(ref, blobs, token, fetchImpl, logger = console) {
  const results = [];
  const failures = [];
  for (let offset = 0; offset < blobs.length; offset += GITHUB_BLOB_BATCH_SIZE) {
    const batch = blobs.slice(offset, offset + GITHUB_BLOB_BATCH_SIZE);
    const fields = batch.map((blob, index) => `b${index}: object(oid: ${JSON.stringify(blob.sha)}) { ... on Blob { text byteSize isBinary } }`).join("\n");
    const query = `query ScoutBlobBatch { repository(owner: ${JSON.stringify(ref.owner)}, name: ${JSON.stringify(ref.name)}) { ${fields} } }`;
    try {
      const response = await requestJson("https://api.github.com/graphql", {
        method: "POST",
        headers: { ...githubHeaders(token), "content-type": "application/json" },
        body: JSON.stringify({ query }),
        fetchImpl,
        timeoutMs: 45_000,
      });
      const repository = response.payload?.data?.repository;
      batch.forEach((blob, index) => {
        const value = repository?.[`b${index}`];
        if (value && !value.isBinary && typeof value.text === "string" && number(value.byteSize) <= 500_000) {
          results.push({ path: blob.path, text: value.text });
        }
      });
    } catch (error) {
      const message = `blob scan failed for ${ref.fullName} at batch ${offset / GITHUB_BLOB_BATCH_SIZE + 1}: ${error.message}`;
      failures.push(message.slice(0, 240));
      logger.error?.(`[repo-enrichment] ${message}`);
    }
  }
  return { files: results, failures };
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
  const { token } = resolveGithubAuth(options);
  const fetchImpl = options.fetchImpl;
  const metadata = options.metadata ?? (await githubGraphqlBatch([ref], token, now, fetchImpl)).get(ref.key);
  if (metadata?.status !== "ok") throw new Error(metadata?.error ?? "repository not found or inaccessible");
  const repo = metadata.repo;
  if (!repo) throw new Error("repository not found or inaccessible");
  const branch = repo.defaultBranchRef?.name;
  if (!branch) throw new Error("repository has no default branch");
  const basePath = `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;

  const [treeResponse, contributorsResponse, advisoriesResponse, baseCommitResponse, activityAttempt] = await Promise.all([
    githubRest(`${basePath}/git/trees/${encodeURIComponent(branch)}`, token, fetchImpl, "?recursive=1"),
    githubRest(`${basePath}/contributors`, token, fetchImpl, "?per_page=1&anon=1"),
    githubRest(`${basePath}/security-advisories`, token, fetchImpl, "?per_page=100").catch((error) => ({ payload: [], advisoryError: error.message })),
    githubRest(`${basePath}/commits`, token, fetchImpl, `?until=${encodeURIComponent(isoBefore(now, 90))}&per_page=1`).catch(() => ({ payload: [] })),
    githubRepositoryActivity(ref, token, now, fetchImpl)
      .then((activity) => ({ activity, error: null }))
      .catch((error) => ({ activity: null, error: String(error?.message ?? error).slice(0, 240) })),
  ]);

  const activity = activityAttempt.activity;
  let activityFallback = null;
  let activityCoverage = "graphql";
  if (!activity) {
    activityCoverage = "rest-fallback";
    options.logger?.warn?.(`[repo-enrichment] ${ref.key} activity GraphQL failed: ${activityAttempt.error}; using REST fallback`);
    activityFallback = await githubActivityRestFallback(basePath, token, now, fetchImpl);
  }

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
  const scanPlan = selectScanBlobs(tree, options.scanOptions);
  const scan = await scanGithubFiles(ref, scanPlan.selected, token, fetchImpl, options.logger ?? console);
  const detected = detectRepositorySignals(tree, scan.files);
  const top = topTwoTree(tree);
  const files = Array.isArray(compare?.files) ? compare.files : [];
  const filesAdded = files.filter((file) => file.status === "added").map((file) => file.filename).sort();
  const advisories = Array.isArray(advisoriesResponse.payload) ? advisoriesResponse.payload : [];
  const advisory = advisorySignals(advisories, tree.map((item) => item.path), now);
  const contributors = parseLastPage(contributorsResponse.headers?.get("link"))
    ?? (Array.isArray(contributorsResponse.payload) ? contributorsResponse.payload.length : 0);
  const cutoff90 = new Date(isoBefore(now, 90)).getTime();
  const pulls = (activity?.pullRequests?.nodes ?? []).filter((pull) => new Date(pull.mergedAt).getTime() >= cutoff90);
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
    commits7d: activity?.defaultBranchRef?.target?.commits7?.totalCount ?? activityFallback?.commits7d ?? null,
    commits30d: activity?.defaultBranchRef?.target?.commits30?.totalCount ?? activityFallback?.commits30d ?? null,
    commits90d: activity?.defaultBranchRef?.target?.commits90?.totalCount ?? activityFallback?.commits90d ?? null,
    filesTouched90d: files.length,
    filesAdded90d: filesAdded.length,
    filesAdded90dList: filesAdded.slice(0, 300),
    files90dTruncated: files.length >= 300 || number(compare?.total_commits) > 250,
    mergedPrs90d: activity ? pulls.length : activityFallback?.mergedPrs90d ?? null,
    maxMergedPrAdditions90d: activity ? pulls.reduce((max, pull) => Math.max(max, number(pull.additions)), 0) : activityFallback?.maxMergedPrAdditions90d ?? null,
    mergedPrs90dTruncated: activity ? pulls.length === 100 : activityFallback?.mergedPrs90dTruncated ?? null,
    activityCoverage,
    advisories: advisoriesResponse.advisoryError ? null : { open: advisory.open, resolved: advisory.resolved, total: advisory.total },
    openRecentAdvisoryPathMatch: advisoriesResponse.advisoryError ? null : advisory.pathMatch,
    advisoryCoverage: advisoriesResponse.advisoryError ? "unavailable" : "repository-advisories",
    scanCoverage: {
      eligible: scanPlan.eligibleCount,
      selected: scanPlan.selected.length,
      filesRead: scan.files.length,
      selectedBytes: scanPlan.selectedBytes,
      complete: scanPlan.complete && scan.files.length === scanPlan.selected.length && scan.failures.length === 0,
      failures: scan.failures.length,
    },
    trapScanStatus: scan.failures.length ? "partial" : scanPlan.complete ? "complete" : "bounded",
    scanErrors: scan.failures.slice(0, 5),
    ...detected,
    secTooling: detected.secTooling ? true : scan.failures.length ? null : false,
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
  for (const path of paths.slice(0, 100)) {
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
  const tree = rawTree.map((item) => ({ path: item.path, type: item.type === "blob" ? "blob" : "tree", sha: item.id, size: 1 }));
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
  const scanPlan = selectScanBlobs(tree, { maxFiles: 100, maxBytes: 2_000_000 });
  const scannedFiles = await scanGitlabFiles(ref, branch, scanPlan.selected.map((item) => item.path), token, fetchImpl);
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
    advisories: null,
    advisoryCoverage: "unavailable",
    openRecentAdvisoryPathMatch: null,
    scanCoverage: { eligible: scanPlan.eligibleCount, selected: scanPlan.selected.length, filesRead: scannedFiles.length, complete: scanPlan.complete && scannedFiles.length === scanPlan.selected.length },
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

function chunks(values, size) {
  const result = [];
  for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size));
  return result;
}

async function mapLimit(values, limit, worker) {
  const queue = [...values];
  const runners = Array.from({ length: Math.min(Math.max(1, limit), queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

function pendingRepository(ref, now, message) {
  return {
    status: "pending",
    provider: ref.provider,
    fullName: ref.fullName,
    url: ref.url,
    fetchedAt: null,
    lastErrorAt: message ? now : null,
    lastError: message ? String(message).slice(0, 240) : null,
    cacheKey: hash(ref.key),
  };
}

export async function enrichRepositoryCache(programs, priorCache = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const ttlHours = Math.max(1, number(options.ttlHours, 24 * 7));
  const forceRefresh = options.forceRefresh === true;
  const concurrency = Math.max(1, number(options.concurrency, 4));
  const maxPerRun = Math.max(1, number(options.maxPerRun, 250));
  const { token: githubToken, source: githubAuthSource } = resolveGithubAuth(options);
  const gitlabToken = options.gitlabToken ?? process.env.GITLAB_TOKEN ?? "";
  const logger = options.logger ?? console;
  const cacheVersion = number(priorCache.version, 0);
  const priorRepositories = priorCache.repositories ?? {};
  const priorRepositoryFor = (ref) => priorRepositories[ref.key]
    ?? priorRepositories[`${ref.provider}:${ref.fullName.toLowerCase()}`]
    ?? null;
  const refs = refsFromPrograms(programs).sort((a, b) => {
    const aEntry = priorRepositoryFor(a);
    const bEntry = priorRepositoryFor(b);
    const aFresh = cacheVersion >= 4 && cacheFresh(aEntry, now, ttlHours);
    const bFresh = cacheVersion >= 4 && cacheFresh(bEntry, now, ttlHours);
    if (aFresh !== bFresh) return aFresh ? 1 : -1;
    return b.priority - a.priority || (aEntry?.fetchedAt ?? "").localeCompare(bEntry?.fetchedAt ?? "");
  });
  const repositories = Object.fromEntries(refs.flatMap((ref) => {
    const entry = priorRepositoryFor(ref);
    return entry ? [[ref.key, entry]] : [];
  }));
  const stale = refs.filter((ref) => forceRefresh || cacheVersion < 4 || !cacheFresh(repositories[ref.key], now, ttlHours));
  const scheduled = stale.slice(0, maxPerRun);
  const githubRefs = scheduled.filter((ref) => ref.provider === "github");
  const gitlabRefs = scheduled.filter((ref) => ref.provider === "gitlab");
  const metadata = new Map();
  const errors = new Map();
  let attempted = scheduled.length;
  let updated = 0;
  let failed = 0;
  let rateLimited = false;
  let batchedQueries = 0;
  let metadataBatchFallbacks = 0;
  let startingRateLimit = null;

  if (refs.some((ref) => ref.provider === "github") && githubToken) {
    try {
      const response = await githubRest("/rate_limit", githubToken, options.fetchImpl);
      const core = response.payload?.resources?.core ?? {};
      const graphql = response.payload?.resources?.graphql ?? {};
      startingRateLimit = {
        coreRemaining: number(core.remaining, null),
        coreLimit: number(core.limit, null),
        graphqlRemaining: number(graphql.remaining, null),
        graphqlLimit: number(graphql.limit, null),
      };
      logger.info?.(`[repo-enrichment] GitHub auth=${githubAuthSource}; core remaining=${core.remaining ?? "unknown"}/${core.limit ?? "unknown"}; graphql remaining=${graphql.remaining ?? "unknown"}/${graphql.limit ?? "unknown"}`);
    } catch (error) {
      logger.error?.(`[repo-enrichment] GitHub auth=${githubAuthSource}; rate-limit probe failed: ${String(error?.message ?? error).slice(0, 180)}`);
    }
  } else if (refs.some((ref) => ref.provider === "github")) {
    logger.error?.("[repo-enrichment] GitHub auth=missing; no unauthenticated requests will be sent");
  }

  if (githubRefs.length && !githubToken) {
    const message = "authenticated GitHub enrichment skipped: GH_PAT/GITHUB_TOKEN is missing";
    logger.error?.(`[repo-enrichment] ${message}`);
    for (const ref of githubRefs) errors.set(ref.key, message);
  } else {
    for (const batch of chunks(githubRefs, GITHUB_METADATA_BATCH_SIZE)) {
      try {
        const result = await githubGraphqlBatchResilient(batch, githubToken, now, options.fetchImpl, logger);
        batchedQueries += result.requests;
        metadataBatchFallbacks += result.fallbacks;
        for (const ref of batch) {
          const value = result.values.get(ref.key);
          if (value?.status === "ok") metadata.set(ref.key, value);
          else errors.set(ref.key, value?.error ?? "GitHub metadata unresolved");
        }
      } catch (error) {
        batchedQueries += 1;
        const message = String(error?.message ?? error).slice(0, 240);
        if (error?.status === 403 || error?.status === 429 || error?.remaining === 0) rateLimited = true;
        for (const ref of batch) errors.set(ref.key, message);
        logger.error?.(`[repo-enrichment] GitHub metadata batch failed (${batch.length} repos): ${message}`);
      }
    }
  }

  await mapLimit(githubRefs.filter((ref) => metadata.has(ref.key)), concurrency, async (ref) => {
    try {
      const value = await enrichGithubRepository(ref, { ...options, token: githubToken, metadata: metadata.get(ref.key) });
      repositories[ref.key] = value;
      updated += 1;
    } catch (error) {
      failed += 1;
      if (error?.status === 403 || error?.status === 429 || error?.remaining === 0) rateLimited = true;
      const message = String(error?.message ?? error).slice(0, 240);
      logger.error?.(`[repo-enrichment] ${ref.key} failed: ${message}`);
      const previous = repositories[ref.key];
      repositories[ref.key] = previous?.status === "ok"
        ? { ...previous, lastErrorAt: now, lastError: String(error.message).slice(0, 180) }
        : pendingRepository(ref, now, message);
    }
  });

  await mapLimit(gitlabRefs, Math.min(concurrency, 3), async (ref) => {
    try {
      repositories[ref.key] = await enrichGitlabRepository(ref, { ...options, token: gitlabToken });
      updated += 1;
    } catch (error) {
      failed += 1;
      const message = String(error?.message ?? error).slice(0, 240);
      logger.error?.(`[repo-enrichment] ${ref.key} failed: ${message}`);
      const previous = repositories[ref.key];
      repositories[ref.key] = previous?.status === "ok"
        ? { ...previous, lastErrorAt: now, lastError: message }
        : pendingRepository(ref, now, message);
    }
  });

  for (const ref of githubRefs.filter((item) => errors.has(item.key))) {
    failed += 1;
    const message = errors.get(ref.key);
    logger.error?.(`[repo-enrichment] ${ref.key} unresolved: ${message}`);
    const previous = repositories[ref.key];
    repositories[ref.key] = previous?.status === "ok"
      ? { ...previous, lastErrorAt: now, lastError: message }
      : pendingRepository(ref, now, message);
  }

  for (const ref of refs) {
    if (!repositories[ref.key]) repositories[ref.key] = pendingRepository(ref, now);
  }

  return {
    cache: { version: 4, generatedAt: scheduled.length ? now : priorCache.generatedAt ?? now, ttlHours, repositories },
    stats: {
      discovered: refs.length,
      stale: stale.length,
      scheduled: scheduled.length,
      deferred: Math.max(0, stale.length - scheduled.length),
      maxPerRun,
      attempted,
      updated,
      failed,
      pending: refs.filter((ref) => repositories[ref.key]?.status !== "ok").length,
      rateLimited,
      authenticated: Boolean(githubToken),
      githubAuthSource,
      startingRateLimit,
      github: githubRefs.length,
      gitlab: gitlabRefs.length,
      batchedQueries,
      metadataBatchFallbacks,
    },
  };
}

export function repositorySignalsFor(target, cache) {
  const ref = parseRepositoryTarget(target?.value);
  return ref ? cache?.repositories?.[ref.key] ?? { status: "pending", provider: ref.provider, fullName: ref.fullName, url: ref.url } : null;
}

export function repositoryCoverageGate(targets, options = {}) {
  const repositoryTargets = targets.filter((target) => target.repoSignals != null);
  const numericHardeningTargets = repositoryTargets.filter((target) => Number.isFinite(target.hardeningIndex)).length;
  const configuredFloor = Math.max(1, number(options.configuredFloor, 400));
  const ratio = Math.min(1, Math.max(0.1, number(options.ratio, 0.8)));
  const requiredHardeningTargets = Math.min(configuredFloor, Math.ceil(repositoryTargets.length * ratio));
  return {
    discoveredTargets: repositoryTargets.length,
    numericHardeningTargets,
    requiredHardeningTargets,
    ratio: repositoryTargets.length ? numericHardeningTargets / repositoryTargets.length : 1,
    ready: numericHardeningTargets >= requiredHardeningTargets,
  };
}

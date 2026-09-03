import { createHash } from "node:crypto";

const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 20);
}

function decodeEntities(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, name) => named[name.toLowerCase()]);
}

export function policyPlainText(input) {
  return decodeEntities(String(input ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_500_000);
}

function parseAmount(raw) {
  const clean = String(raw).replace(/[,\s]/g, "").toLowerCase();
  const match = clean.match(/(\d+(?:\.\d+)?)([km])?/);
  if (!match) return null;
  const multiplier = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : 1;
  const value = Number(match[1]) * multiplier;
  return Number.isFinite(value) ? value : null;
}

function amountsNear(text, severity) {
  const values = [];
  const expression = new RegExp(`\\b${severity}\\b`, "gi");
  for (const match of text.matchAll(expression)) {
    const afterStart = match.index + severity.length;
    let after = text.slice(afterStart, Math.min(text.length, afterStart + 140));
    const nextSeverity = after.search(/\b(?:low|medium|high|critical)\b/i);
    if (nextSeverity >= 0) after = after.slice(0, nextSeverity);
    const following = after.match(/(?:US\$|USD|EUR|GBP|\$|€|£)\s*([0-9][0-9,]*(?:\.\d+)?\s*[km]?)/i);
    if (following) {
      const value = parseAmount(following[1]);
      if (value != null) values.push(value);
      continue;
    }
    const before = text.slice(Math.max(0, match.index - 80), match.index);
    const preceding = [...before.matchAll(/(?:US\$|USD|EUR|GBP|\$|€|£)\s*([0-9][0-9,]*(?:\.\d+)?\s*[km]?)/gi)].at(-1);
    const value = preceding ? parseAmount(preceding[1]) : null;
    if (value != null) values.push(value);
  }
  return values;
}

function countryExclusions(text) {
  const countries = [];
  if (/(?:india|indian).{0,100}(?:not eligible|ineligible|excluded|prohibited|cannot participate|not available)|(?:not eligible|ineligible|excluded|prohibited|cannot participate|not available).{0,100}(?:india|indian)/i.test(text)) {
    countries.push("IN");
  }
  return countries;
}

export function extractPolicySignals(input, options = {}) {
  const text = policyPlainText(input);
  const minimumPayableReward = Number(options.minimumPayableReward ?? 1_000);
  const rewardsBySeverity = {};
  for (const severity of SEVERITIES) {
    const amounts = amountsNear(text, severity);
    if (amounts.length) rewardsBySeverity[severity] = Math.max(...amounts);
  }

  let programFloorSeverity = SEVERITIES.find((severity) => Number(rewardsBySeverity[severity] ?? 0) >= minimumPayableReward) ?? null;
  let floorSource = programFloorSeverity ? "scraped-reward-table" : null;
  if (!programFloorSeverity && /\blow\b.{0,100}(?:not eligible|no bounty|not rewarded|out of scope)|(?:not eligible|no bounty|not rewarded|out of scope).{0,100}\blow\b/i.test(text)) {
    programFloorSeverity = "MEDIUM";
    floorSource = "scraped-low-exclusion";
  }

  const reportMatch = text.match(/([0-9][0-9,]*)\s+(?:resolved|triaged|valid)\s+reports?/i)
    ?? text.match(/(?:resolved|triaged|valid)\s+reports?\D{0,12}([0-9][0-9,]*)/i);

  return {
    programFloorSeverity,
    floorSource,
    rewardsBySeverity,
    inviteOnly: /\binvite[- ]only\b|\bprivate program\b|participation is by invitation/i.test(text),
    kycRequired: /(?:kyc|know your customer|identity verification).{0,80}(?:required|mandatory|must)|(?:required|mandatory|must).{0,80}(?:kyc|identity verification)/i.test(text),
    excludedCountries: countryExclusions(text),
    noSafeHarbor: /\bno safe harbou?r\b|safe harbou?r does not apply/i.test(text),
    safeHarborRequired: false,
    resolvedReports: reportMatch ? Number(reportMatch[1].replaceAll(",", "")) : null,
    textBytes: Buffer.byteLength(text),
    useful: Boolean(programFloorSeverity || Object.keys(rewardsBySeverity).length || reportMatch),
  };
}

async function fetchPolicy(program, options) {
  const response = await (options.fetchImpl ?? fetch)(program.url, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5",
      "user-agent": "ScoutIQ/2.0 policy-enrichment (+public bug bounty research planning)",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > 4_000_000) throw new Error("policy response exceeds size cap");
  const text = await response.text();
  if (Buffer.byteLength(text) > 4_000_000) throw new Error("policy response exceeds size cap");
  return text;
}

function fresh(entry, now, ttlHours) {
  if (!entry?.fetchedAt || entry.status !== "ok") return false;
  const age = new Date(now).getTime() - new Date(entry.fetchedAt).getTime();
  return Number.isFinite(age) && age < ttlHours * 3_600_000;
}

function policyKey(program) {
  return `${program.id}:${hash(program.url)}`;
}

export async function enrichPolicyCache(programs, priorCache = {}, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const budget = Math.max(0, Number(options.budget ?? 5));
  const ttlHours = Math.max(12, Number(options.ttlHours ?? 168));
  const minimumPayableReward = Number(options.minimumPayableReward ?? 1_000);
  const policies = { ...(priorCache.policies ?? {}) };
  const candidates = [...programs].sort((a, b) => {
    const aEntry = policies[policyKey(a)];
    const bEntry = policies[policyKey(b)];
    const aFresh = fresh(aEntry, now, ttlHours);
    const bFresh = fresh(bEntry, now, ttlHours);
    if (aFresh !== bFresh) return aFresh ? 1 : -1;
    const priority = { new_target: 3, new_program: 2, scope_updated: 1, baseline: 0 };
    return (priority[b.change?.type] ?? 0) - (priority[a.change?.type] ?? 0);
  });
  let attempted = 0;
  let updated = 0;
  let failed = 0;

  for (const program of candidates) {
    const key = policyKey(program);
    const inline = String(program.policyText ?? "").trim();
    const inlineHash = inline ? hash(inline) : null;
    if (inline && policies[key]?.inlineHash !== inlineHash) {
      const signals = extractPolicySignals(inline, { minimumPayableReward });
      policies[key] = { status: signals.useful ? "ok" : "partial", fetchedAt: now, source: "dataset", inlineHash, ...signals };
      updated += 1;
      if (signals.useful) continue;
    }
    if (fresh(policies[key], now, ttlHours) || attempted >= budget) continue;
    attempted += 1;
    try {
      const body = await fetchPolicy(program, options);
      policies[key] = { status: "ok", fetchedAt: now, source: "official-policy", ...extractPolicySignals(body, { minimumPayableReward }) };
      updated += 1;
    } catch (error) {
      failed += 1;
      const previous = policies[key];
      policies[key] = previous?.status === "ok"
        ? { ...previous, lastErrorAt: now, lastError: String(error.message).slice(0, 180) }
        : { status: "pending", fetchedAt: null, lastErrorAt: now, lastError: String(error.message).slice(0, 180) };
    }
  }

  return {
    cache: { version: 2, generatedAt: now, policies },
    stats: {
      discovered: programs.length,
      attempted,
      updated,
      failed,
      pending: programs.filter((program) => policies[policyKey(program)]?.status !== "ok").length,
    },
  };
}

export function policySignalsFor(program, cache) {
  return cache?.policies?.[policyKey(program)] ?? null;
}

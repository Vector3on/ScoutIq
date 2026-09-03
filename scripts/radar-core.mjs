import { createHash } from "node:crypto";

const OPEN_WORDS = /^(active|enabled|open|opened|public|accepting|live)$/i;
const CLOSED_WORDS = /(closed|disabled|paused|retired|ended|inactive)/i;
const SOURCE_CODE_WORDS = /(source[ -]?code|repository|\brepo\b|github\.com|gitlab\.com|open[ -]?source)/i;
const LOCAL_WORDS = /(local(?:ly)?|testnet|sandbox|docker|self-host|researcher-owned|own account)/i;

export function slug(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96);
}

function stableHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/[^0-9.-]+/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function isoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function moneyValue(raw, snakeName, camelName) {
  const candidate = firstDefined(raw?.[snakeName], raw?.[camelName]);
  if (candidate && typeof candidate === "object") {
    return {
      value: asNumber(firstDefined(candidate.value, candidate.amount, candidate.max)),
      currency: firstDefined(candidate.currency, candidate.currency_code, candidate.code) ?? null,
    };
  }
  return { value: asNumber(candidate), currency: null };
}

function normalizeCurrency(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const code = value.trim().toUpperCase();
  const aliases = { "$": "USD", "US$": "USD", "€": "EUR", "£": "GBP" };
  return aliases[code] ?? (code.length === 3 ? code : null);
}

export function normalizeTargetType(value) {
  const type = String(value ?? "other").toLowerCase().replaceAll("_", "-");
  if (/(source|repository|github|gitlab)/.test(type)) return "source-code";
  if (/(smart.?contract|blockchain-contract)/.test(type)) return "smart-contract";
  if (/(api|graphql)/.test(type)) return "api";
  if (/(android|ios|mobile|apk)/.test(type)) return "mobile";
  if (/(firmware)/.test(type)) return "firmware";
  if (/(hardware|device|iot)/.test(type)) return "hardware";
  if (/(executable|binary|desktop)/.test(type)) return "executable";
  if (/(domain|url|website|web-application|wildcard|cidr|ip-address)/.test(type)) return "web";
  return type || "other";
}

function normalizeTarget(rawTarget) {
  const raw = typeof rawTarget === "string" ? { target: rawTarget } : rawTarget ?? {};
  const value = String(
    firstDefined(
      raw.asset_identifier,
      raw.identifier,
      raw.target,
      raw.endpoint,
      raw.uri,
      raw.url,
      raw.name,
    ) ?? "",
  ).trim();
  if (!value) return null;
  const type = normalizeTargetType(
    firstDefined(raw.asset_type, raw.type, raw.target_type, raw.category),
  );
  const eligibleValue = firstDefined(raw.eligible_for_bounty, raw.eligible, raw.bounty_eligible);
  const eligible = eligibleValue == null ? true : Boolean(eligibleValue);
  const description = firstDefined(raw.description, raw.instructions, raw.notes);
  const impact = firstDefined(raw.impact, raw.tier, raw.severity);
  const addedAt = isoDate(firstDefined(raw.added_at, raw.created_at, raw.first_seen_at, raw.addedAt));
  const identity = `${type}:${value.toLowerCase().replace(/\s+/g, " ")}`;
  return {
    key: stableHash(identity),
    type,
    value,
    eligible,
    ...(description ? { description: String(description).slice(0, 600) } : {}),
    ...(impact ? { impact: String(impact).slice(0, 120) } : {}),
    ...(addedAt ? { addedAt } : {}),
  };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    return Object.values(value).flatMap((item) => (Array.isArray(item) ? item : []));
  }
  return [];
}

function extractRecords(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["programs", "data", "items", "results"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function extractTargets(raw, adapter) {
  if (adapter === "projectdiscovery") {
    return asArray(raw.domains).map((domain) => ({ type: "domain", target: domain }));
  }
  const candidates = [
    raw?.targets?.in_scope,
    raw?.scope?.in_scope,
    raw?.scopes?.in_scope,
    raw?.in_scope,
    raw?.targets,
  ];
  const selected = candidates.find((value) => Array.isArray(value) || (value && typeof value === "object"));
  return asArray(selected);
}

function statusOf(raw) {
  if (raw.disabled === true || raw.closed === true) return "closed";
  const status = String(
    firstDefined(raw.submission_state, raw.status, raw.state, raw.program_status) ?? "open",
  ).trim();
  if (CLOSED_WORDS.test(status)) return "closed";
  if (OPEN_WORDS.test(status) || !status) return "open";
  return status.toLowerCase();
}

function safeHarborOf(raw) {
  const value = firstDefined(raw.safe_harbor, raw.safeHarbor);
  if (value === true) return "program-defined";
  if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  return null;
}

function disclosureOf(raw) {
  const value = firstDefined(raw.allows_disclosure, raw.disclosure_allowed, raw.disclosureAllowed);
  return typeof value === "boolean" ? value : null;
}

function programUrl(source, raw) {
  const direct = firstDefined(raw.url, raw.program_url, raw.policy_url, raw.link);
  if (typeof direct === "string" && /^https?:\/\//i.test(direct)) return direct;
  const handle = firstDefined(raw.handle, raw.slug, raw.id);
  if (source.programUrlTemplate && handle) {
    return source.programUrlTemplate.replace("{id}", encodeURIComponent(String(handle)));
  }
  return source.homepage;
}

function rewardOf(raw) {
  const min = moneyValue(raw, "min_bounty", "minBounty");
  const max = moneyValue(raw, "max_bounty", "maxBounty");
  const payout = moneyValue(raw, "max_payout", "maxPayout");
  const reward = raw.rewards && typeof raw.rewards === "object" ? raw.rewards : {};
  const rewardMin = moneyValue(reward, "min_bounty", "minimum");
  const rewardMax = moneyValue(reward, "max_bounty", "maximum");
  const minReward = firstDefined(min.value, rewardMin.value, null);
  const maxReward = firstDefined(max.value, payout.value, rewardMax.value, null);
  const currency = normalizeCurrency(
    firstDefined(
      min.currency,
      max.currency,
      payout.currency,
      rewardMin.currency,
      rewardMax.currency,
      raw.currency,
      raw.currency_code,
    ),
  );
  return { minReward, maxReward, currency };
}

function paidOf(raw, reward, adapter) {
  const explicit = firstDefined(
    raw.offers_bounties,
    raw.offers_awards,
    raw.bounty,
    raw.paid,
    raw.rewarded,
  );
  if (typeof explicit === "boolean") return explicit;
  if ((reward.maxReward ?? 0) > 0 || (reward.minReward ?? 0) > 0) return true;
  return adapter !== "projectdiscovery" ? false : Boolean(raw.bounty);
}

function languagesOf(text) {
  const checks = [
    ["solidity", /\bsolidity\b/i],
    ["rust", /\brust\b|\.rs\b/i],
    ["go", /\bgolang\b|\bgo code\b|\.go\b/i],
    ["typescript", /\btypescript\b|\.tsx?\b/i],
    ["javascript", /\bjavascript\b|\.jsx?\b/i],
    ["python", /\bpython\b|\.py\b/i],
    ["java", /\bjava\b/i],
    ["kotlin", /\bkotlin\b/i],
    ["swift", /\bswift\b/i],
    ["c++", /\bc\+\+\b|\.cpp\b/i],
    ["c", /\bc language\b|\.c\b/i],
    ["php", /\bphp\b/i],
    ["ruby", /\bruby\b/i],
  ];
  return checks.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function tagsOf(targets, text) {
  const tags = new Set(targets.map((target) => target.type));
  if (/smart.?contract|blockchain|web3|testnet/i.test(text)) tags.add("blockchain");
  if (/\bai\b|machine learning|llm/i.test(text)) tags.add("ai/ml");
  if (/firmware/i.test(text)) tags.add("firmware");
  if (/security tool|scanner|sast|dependency/i.test(text)) tags.add("security-tooling");
  if (/\bapi\b|graphql/i.test(text)) tags.add("api");
  if (SOURCE_CODE_WORDS.test(text)) tags.add("source-code");
  return [...tags].filter(Boolean).sort();
}

export function normalizeSource(source, payload) {
  const records = extractRecords(payload);
  const normalized = [];

  for (const raw of records) {
    if (!raw || typeof raw !== "object" || raw.public === false) continue;
    const name = String(firstDefined(raw.name, raw.program_name, raw.title, raw.company) ?? "").trim();
    if (!name) continue;
    const reward = rewardOf(raw);
    const paid = paidOf(raw, reward, source.adapter);
    if (source.paidOnly !== false && !paid) continue;

    const targets = extractTargets(raw, source.adapter)
      .map(normalizeTarget)
      .filter(Boolean)
      .filter((target) => target.eligible !== false);
    const uniqueTargets = [...new Map(targets.map((target) => [target.key, target])).values()]
      .sort((a, b) => a.key.localeCompare(b.key));
    const descriptiveText = [
      raw.description,
      raw.policy,
      raw.rules,
      raw.notes,
      ...uniqueTargets.flatMap((target) => [target.value, target.description, target.impact]),
    ]
      .filter(Boolean)
      .join(" ");
    const policyText = [raw.description, raw.policy, raw.rules, raw.notes, raw.eligibility]
      .filter(Boolean)
      .map(String)
      .join(" ")
      .slice(0, 100_000);
    const tags = tagsOf(uniqueTargets, descriptiveText);
    const sourceCode = tags.includes("source-code");
    const repositoryCount = uniqueTargets.filter(
      (target) => target.type === "source-code" || /github\.com|gitlab\.com/i.test(target.value),
    ).length;

    normalized.push({
      mergeKey: slug(name),
      name,
      platform: source.platform,
      url: programUrl(source, raw),
      status: statusOf(raw),
      paid,
      currency: reward.currency,
      minReward: reward.minReward,
      maxReward: reward.maxReward,
      safeHarbor: safeHarborOf(raw),
      disclosureAllowed: disclosureOf(raw),
      sourceIds: [source.id],
      sourceCode,
      repositoryCount,
      targetCount: uniqueTargets.length,
      tags,
      languages: languagesOf(descriptiveText),
      targets: uniqueTargets,
      localTestingHint: LOCAL_WORDS.test(descriptiveText),
      policyText,
      launchedAt: isoDate(firstDefined(raw.launched_at, raw.started_at, raw.created_at, raw.createdAt)),
      resolvedReports: asNumber(firstDefined(
        raw.resolved_reports,
        raw.reports_resolved,
        raw.resolvedReports,
        raw.valid_reports,
      )),
      inviteOnly: Boolean(firstDefined(raw.invite_only, raw.inviteOnly, raw.private, false)),
      kycRequired: Boolean(firstDefined(raw.kyc_required, raw.kycRequired, false)),
      excludedCountries: Array.isArray(raw.excluded_countries) ? raw.excluded_countries.map(String) : [],
      sourcePriority: source.priority ?? 100,
    });
  }

  return normalized.sort((a, b) => a.mergeKey.localeCompare(b.mergeKey));
}

export function mergePrograms(records) {
  const groups = new Map();
  for (const record of records) {
    const key = record.mergeKey || slug(record.name);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }

  return [...groups.entries()].map(([key, group]) => {
    group.sort((a, b) => a.sourcePriority - b.sourcePriority || (b.maxReward ?? 0) - (a.maxReward ?? 0));
    const lead = group[0];
    const targets = [...new Map(group.flatMap((record) => record.targets).map((target) => [target.key, target])).values()]
      .sort((a, b) => a.key.localeCompare(b.key));
    const rewardRecords = group.filter((record) => record.maxReward != null || record.minReward != null);
    const maxReward = rewardRecords.length
      ? Math.max(...rewardRecords.map((record) => record.maxReward ?? 0))
      : null;
    const positiveMinimums = rewardRecords.map((record) => record.minReward).filter((value) => value != null && value > 0);
    const minReward = positiveMinimums.length ? Math.min(...positiveMinimums) : null;
    const rewardLead = rewardRecords.sort((a, b) => (b.maxReward ?? 0) - (a.maxReward ?? 0))[0];
    const sourceIds = [...new Set(group.flatMap((record) => record.sourceIds))].sort();
    const sourceCode = group.some((record) => record.sourceCode);
    const repositoryCount = Math.max(...group.map((record) => record.repositoryCount ?? 0));
    return {
      id: `program:${key}`,
      name: lead.name,
      platform: lead.platform,
      url: lead.url,
      status: group.some((record) => record.status === "open") ? "open" : lead.status,
      paid: group.some((record) => record.paid),
      currency: rewardLead?.currency ?? null,
      minReward,
      maxReward,
      safeHarbor: group.map((record) => record.safeHarbor).find(Boolean) ?? null,
      disclosureAllowed: group.map((record) => record.disclosureAllowed).find((value) => value != null) ?? null,
      sourceIds,
      sourceCode,
      repositoryCount,
      targetCount: targets.length,
      tags: [...new Set(group.flatMap((record) => record.tags))].sort(),
      languages: [...new Set(group.flatMap((record) => record.languages))].sort(),
      targets,
      localTestingHint: group.some((record) => record.localTestingHint),
      policyText: group.map((record) => record.policyText).filter(Boolean).join(" ").slice(0, 150_000),
      launchedAt: group.map((record) => record.launchedAt).filter(Boolean).sort()[0] ?? null,
      resolvedReports: Math.max(...group.map((record) => record.resolvedReports ?? -1)) >= 0
        ? Math.max(...group.map((record) => record.resolvedReports ?? -1))
        : null,
      inviteOnly: group.some((record) => record.inviteOnly),
      kycRequired: group.some((record) => record.kycRequired),
      excludedCountries: [...new Set(group.flatMap((record) => record.excludedCountries ?? []))],
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function targetFingerprint(program) {
  return program.targets.map((target) => target.key).sort().join(",");
}

function coreFingerprint(program) {
  return JSON.stringify({
    name: program.name,
    platform: program.platform,
    url: program.url,
    status: program.status,
    paid: program.paid,
    currency: program.currency,
    minReward: program.minReward,
    maxReward: program.maxReward,
    safeHarbor: program.safeHarbor,
    disclosureAllowed: program.disclosureAllowed,
    launchedAt: program.launchedAt,
    resolvedReports: program.resolvedReports,
    inviteOnly: program.inviteOnly,
    kycRequired: program.kycRequired,
    excludedCountries: program.excludedCountries,
    sourceIds: program.sourceIds,
    tags: program.tags,
    languages: program.languages,
    targets: targetFingerprint(program),
  });
}

function changeFor(program, previous, now, baseline) {
  if (!previous) {
    return {
      type: baseline ? "baseline" : "new_program",
      label: baseline ? "Baseline import" : "New program",
      at: now,
    };
  }
  const oldKeys = new Set(previous.targets.map((target) => target.key));
  const newKeys = new Set(program.targets.map((target) => target.key));
  const addedTargets = [...newKeys].filter((key) => !oldKeys.has(key)).length;
  const removedTargets = [...oldKeys].filter((key) => !newKeys.has(key)).length;
  if (addedTargets > 0) {
    return { type: "new_target", label: `${addedTargets} target${addedTargets === 1 ? "" : "s"} added`, at: now, addedTargets, ...(removedTargets ? { removedTargets } : {}) };
  }
  if ((program.maxReward ?? 0) > (previous.maxReward ?? 0)) {
    return { type: "reward_up", label: "Reward increased", at: now };
  }
  if (previous.status !== "open" && program.status === "open") {
    return { type: "reactivated", label: "Program reactivated", at: now };
  }
  if (removedTargets > 0 || coreFingerprint(program) !== coreFingerprint(previous)) {
    return { type: "scope_updated", label: "Scope or policy changed", at: now, ...(removedTargets ? { removedTargets } : {}) };
  }
  return previous.change;
}

export function scoreProgram(program, now = new Date().toISOString()) {
  const changeBase = {
    new_target: 32,
    new_program: 27,
    reward_up: 24,
    reactivated: 22,
    scope_updated: 18,
    baseline: 5,
  }[program.change.type] ?? 5;
  const ageDays = Math.max(0, Math.floor((new Date(now).getTime() - new Date(program.change.at).getTime()) / 86_400_000));
  const freshness = Math.max(2, changeBase - ageDays * 3);

  const ceiling = program.maxReward ?? 0;
  let reward = ceiling >= 100_000 ? 22 : ceiling >= 50_000 ? 20 : ceiling >= 25_000 ? 18 : ceiling >= 10_000 ? 15 : ceiling >= 5_000 ? 12 : ceiling >= 1_000 ? 8 : ceiling > 0 ? 4 : 0;
  if ((program.minReward ?? 0) >= 1_000) reward = Math.min(22, reward + 2);

  let inspectability = 0;
  if (program.sourceCode) inspectability += 14;
  inspectability += Math.min(6, (program.repositoryCount ?? 0) * 2);
  if (program.tags.includes("smart-contract")) inspectability += 5;
  else if (program.tags.includes("api")) inspectability += 4;
  if (program.localTestingHint) inspectability += 3;
  if (program.languages.length) inspectability += 2;
  inspectability = Math.min(24, inspectability);

  let authorization = 0;
  if (program.paid) authorization += 6;
  if (program.status === "open") authorization += 4;
  if (program.safeHarbor) authorization += 3;
  if (program.disclosureAllowed === true) authorization += 1;

  let friction = program.targetCount <= 3 ? 5 : program.targetCount <= 10 ? 3 : program.targetCount <= 25 ? 1 : 0;
  if (program.maxReward != null) friction += 1;
  if (program.tags.some((tag) => ["source-code", "api", "smart-contract", "firmware", "hardware"].includes(tag))) friction += 2;
  friction = Math.min(8, friction);

  const reasons = [];
  if (program.change.type === "new_target") reasons.push(program.change.label);
  else if (program.change.type !== "baseline") reasons.push(program.change.label);
  if (program.sourceCode) reasons.push("Inspectable source-code scope");
  else if (program.tags.includes("api")) reasons.push("Structured API surface");
  if (program.localTestingHint) reasons.push("Local, sandbox, or testnet testing language detected");
  if ((program.maxReward ?? 0) >= 1_000) reasons.push("Confirmed reward ceiling clears $1,000");
  if (program.targetCount <= 5) reasons.push(`Small scope with ${program.targetCount} tracked target${program.targetCount === 1 ? "" : "s"}`);
  if (program.safeHarbor) reasons.push("Safe-harbor field is present, verify the official wording");
  if (!reasons.length) reasons.push("Paid public program with structured scope data");

  const score = freshness + reward + inspectability + authorization + friction;
  const attentionPressure = freshness >= 26 && inspectability >= 16 && program.targetCount <= 10
    ? "lower"
    : freshness >= 18
      ? "medium"
      : "unknown";
  return {
    score,
    scoreBreakdown: { freshness, reward, inspectability, authorization, friction },
    reasons: reasons.slice(0, 5),
    attentionPressure,
  };
}

export function reconcilePrograms(currentPrograms, previousPrograms, now, { baseline = false } = {}) {
  const previousById = new Map(previousPrograms.map((program) => [program.id, program]));
  const currentIds = new Set(currentPrograms.map((program) => program.id));
  const events = [];
  const reconciled = [];

  for (const current of currentPrograms) {
    const previous = previousById.get(current.id);
    const change = changeFor(current, previous, now, baseline);
    const changed = !previous || coreFingerprint(current) !== coreFingerprint(previous);
    const previousTargets = new Map((previous?.targets ?? []).map((target) => [target.key, target]));
    const targets = current.targets.map((target) => {
      const priorTarget = previousTargets.get(target.key);
      return {
        ...target,
        firstSeenAt: priorTarget?.firstSeenAt ?? target.addedAt ?? (baseline ? null : now),
      };
    });
    const program = {
      ...current,
      targets,
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastSeenAt: changed ? now : previous?.lastSeenAt ?? now,
      lastChangedAt: change === previous?.change ? previous.lastChangedAt : now,
      change,
      missingCount: 0,
    };
    Object.assign(program, scoreProgram(program, now));
    reconciled.push(program);
    if (!baseline && change !== previous?.change) {
      events.push({
        id: `${now}:${program.id}:${change.type}`,
        programId: program.id,
        programName: program.name,
        platform: program.platform,
        url: program.url,
        score: program.score,
        change,
      });
    }
  }

  for (const previous of previousPrograms) {
    if (currentIds.has(previous.id)) continue;
    const missingCount = (previous.missingCount ?? 0) + 1;
    if (missingCount >= 2) continue;
    const stale = {
      ...previous,
      status: "stale",
      missingCount,
    };
    Object.assign(stale, scoreProgram(stale, now));
    reconciled.push(stale);
  }

  return {
    programs: reconciled.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)),
    events: events.sort((a, b) => b.score - a.score),
  };
}

export function publicProgram(program, targetLimit = 16) {
  const compactRepoSignals = (signals) => signals ? {
    status: signals.status,
    provider: signals.provider,
    fullName: signals.fullName,
    url: signals.url,
    fetchedAt: signals.fetchedAt ?? null,
    createdAt: signals.createdAt ?? null,
    pushedAt: signals.pushedAt ?? null,
    ageY: signals.ageY ?? null,
    stars: signals.stars ?? 0,
    forks: signals.forks ?? 0,
    contributorsCount: signals.contributorsCount ?? 0,
    releases: signals.releases ?? 0,
    defaultBranch: signals.defaultBranch ?? null,
    languages: signals.languages ?? {},
    commits7d: signals.commits7d ?? 0,
    commits30d: signals.commits30d ?? 0,
    commits90d: signals.commits90d ?? 0,
    filesTouched90d: signals.filesTouched90d ?? 0,
    filesAdded90d: signals.filesAdded90d ?? 0,
    filesAdded90dList: (signals.filesAdded90dList ?? []).slice(0, 40),
    files90dTruncated: Boolean(signals.files90dTruncated),
    mergedPrs90d: signals.mergedPrs90d ?? 0,
    maxMergedPrAdditions90d: signals.maxMergedPrAdditions90d ?? 0,
    secTooling: Boolean(signals.secTooling),
    securityMd: Boolean(signals.securityMd),
    fuzzPath: Boolean(signals.fuzzPath),
    fuzzFunction: Boolean(signals.fuzzFunction),
    securityWorkflows: signals.securityWorkflows ?? [],
    advisories: signals.advisories ?? { open: 0, resolved: 0, total: 0 },
    advisoryCoverage: signals.advisoryCoverage ?? "unknown",
    trapHits: (signals.trapHits ?? []).slice(0, 10),
    trapTags: signals.trapTags ?? [],
    devKnown: Boolean(signals.devKnown),
    securityFixGated: Boolean(signals.securityFixGated),
    openRecentAdvisoryPathMatch: Boolean(signals.openRecentAdvisoryPathMatch),
    lastError: signals.lastError,
  } : null;
  const rankedTargets = [...program.targets].sort((a, b) => {
    if (a.key === program.bestTargetKey) return -1;
    if (b.key === program.bestTargetKey) return 1;
    return (b.evScore ?? 0) - (a.evScore ?? 0);
  });
  const targets = rankedTargets.slice(0, targetLimit).map((target) => ({
    ...target,
    repoSignals: compactRepoSignals(target.repoSignals),
  }));
  const value = { ...program, targets, repoSignals: compactRepoSignals(program.repoSignals) };
  delete value.missingCount;
  delete value.localTestingHint;
  delete value.policyText;
  return value;
}

export function datasetSignature(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

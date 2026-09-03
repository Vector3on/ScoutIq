const SEVERITY = Object.freeze({ NONE: 0, INFORMATIVE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 });
const SEVERITY_NAMES = Object.freeze(["INFORMATIVE", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);

const MATURE_CORE = /(crypto|signing|mpc|consensus|kernel|tls|wallet[-_ ]?core)/i;
const PARSER = /(parser|serializer|codec|deseriali[sz]e|rlp|protobuf)/i;
const CRYPTO = /(crypto|signing|signature|mpc|nonce|keystore|hsm|consensus|wallet[-_ ]?core)/i;
const AUTH = /(oauth|oidc|saml|session|jwt|login|account[-_ ]?link|sso|authentication)/i;
const AUTHZ = /(idor|bola|multi[-_ ]?tenant|rbac|k8s[-_ ]?operator|operator|iam|authorization)/i;
const AI = /(^|[^a-z])(ai|ml|llm|rag|mcp)([^a-z]|$)|agent|prompt[-_ ]?inject/i;
const CONTRACT = /(solidity|defi|smart[-_ ]?contract|\bevm\b|vault)/i;
const PAYMENTS = /(payments?|checkout|billing|store|entitlement|subscription|invoice|cart)/i;
const UNTRUSTED_INPUT = /(network|packet|socket|upload|file|wire|request|remote|untrusted|p2p)/i;

export function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

export function round(value, places = 3) {
  const factor = 10 ** places;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

export function severityRank(value) {
  if (typeof value === "number") return clamp(Math.round(value), 0, 4);
  return SEVERITY[String(value ?? "").trim().toUpperCase()] ?? SEVERITY.MEDIUM;
}

export function severityName(value) {
  return SEVERITY_NAMES[severityRank(value)] ?? "MEDIUM";
}

function norm(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function daysBetween(older, newer) {
  const delta = new Date(newer).getTime() - new Date(older).getTime();
  return Number.isFinite(delta) ? Math.max(0, delta / 86_400_000) : null;
}

function repoText(repoSignals) {
  if (!repoSignals) return "";
  return [
    repoSignals.fullName,
    repoSignals.defaultBranch,
    ...(repoSignals.languages ? Object.keys(repoSignals.languages) : []),
    ...(repoSignals.treeTop2 ?? []),
    ...(repoSignals.filesAdded90dList ?? []),
  ].filter(Boolean).join(" ");
}

function targetText(program, target, repoSignals) {
  return [
    program.name,
    target.type,
    target.value,
    target.description,
    target.impact,
    ...(program.tags ?? []),
    ...(program.languages ?? []),
    repoText(repoSignals),
  ].filter(Boolean).join(" ");
}

export function calculateHardeningIndex(repoSignals, text = "") {
  if (!repoSignals || repoSignals.status === "pending") return 0;
  const ageY = Number(repoSignals.ageY ?? 0);
  const advisories = repoSignals.advisories ?? {};
  let score = Math.min(30, Math.max(0, Number(repoSignals.stars ?? 0)) / 300);
  if (repoSignals.secTooling) score += 20;
  if (ageY > 4) score += 15;
  if (Number(repoSignals.contributorsCount ?? 0) > 100) score += 15;
  if (Number(advisories.resolved ?? 0) >= 3) score += 10;
  if (MATURE_CORE.test(`${text} ${repoText(repoSignals)}`)) score += 10;
  return round(clamp(score, 0, 100), 1);
}

export function calculateFreshCodeIndex(repoSignals, { recentScope = false } = {}) {
  let score = 0;
  if (repoSignals && repoSignals.status !== "pending") {
    score += Math.min(35, Math.max(0, Number(repoSignals.commits90d ?? 0)) / 2);
    score += Math.min(25, Math.max(0, Number(repoSignals.filesAdded90d ?? 0)) * 3);
    if (Number(repoSignals.maxMergedPrAdditions90d ?? 0) > 800) score += 20;
  }
  if (recentScope) score += 20;
  return round(clamp(score, 0, 100), 1);
}

export function calculateKnownIssueRisk(repoSignals) {
  if (!repoSignals) return 0;
  let score = 0;
  if ((repoSignals.trapHits ?? []).length > 0 || repoSignals.devKnown) score += 40;
  if (repoSignals.openRecentAdvisoryPathMatch) score += 30;
  if (repoSignals.securityFixGated) score += 30;
  return clamp(score, 0, 100);
}

function baseWorkflow(target, text, repoSignals, liveState) {
  const type = String(target.type ?? "").toLowerCase();
  const repository = Boolean(repoSignals) || /github\.com|gitlab\.com/i.test(target.value ?? "");
  if (type === "smart-contract" || (CONTRACT.test(text) && liveState?.deployed != null)) return "live-contract";
  if (!repository && AI.test(text)) return "ai-agent";
  if (!repository && (type === "api" || /(^|[./_-])api([./_-]|$)/i.test(target.value ?? ""))) return "live-api";
  if (!repository && ["web", "domain", "url", "mobile"].includes(type)) return "live-web";
  if (repository || ["source-code", "firmware", "hardware", "executable", "binary"].includes(type)) return "static-source";
  if (!repository && /^https?:\/\//i.test(target.value ?? "")) return "live-web";
  if (!repository && /^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/|$)/i.test(target.value ?? "")) return "live-web";
  if (CONTRACT.test(text)) return "live-contract";
  return "static-source";
}

export function classifyFindable(program, target, repoSignals = null, liveState = null) {
  const text = targetText(program, target, repoSignals);
  const workflow = baseWorkflow(target, text, repoSignals, liveState);
  const languages = new Set([
    ...(program.languages ?? []),
    ...Object.keys(repoSignals?.languages ?? {}),
  ].map((value) => String(value).toLowerCase()));
  const isLive = workflow.startsWith("live-") || workflow === "ai-agent";

  if (isLive && AUTH.test(text)) {
    return { className: "account-takeover", ceiling: "CRITICAL", proficiencyFit: 0.95, workflow, label: "ATO" };
  }
  if (isLive && AUTHZ.test(text)) {
    return { className: "cross-tenant-authz", ceiling: "CRITICAL", proficiencyFit: 0.9, workflow, label: "cross-tenant" };
  }
  if (workflow === "ai-agent" || AI.test(text) && isLive) {
    return { className: "agent-sink-chain", ceiling: "HIGH", proficiencyFit: 0.65, workflow: "ai-agent", label: "exfil/SSRF" };
  }
  if (workflow === "live-contract" || CONTRACT.test(text) && liveState?.deployed) {
    return { className: "contract-loss", ceiling: "CRITICAL", proficiencyFit: 0.55, workflow: "live-contract", label: "contract loss" };
  }
  if (isLive && PAYMENTS.test(text)) {
    return { className: "business-logic", ceiling: "CRITICAL", proficiencyFit: 0.85, workflow, label: "price/authz" };
  }
  if (PARSER.test(text)) {
    const native = languages.has("c") || languages.has("c++") || languages.has("cpp");
    if (native && UNTRUSTED_INPUT.test(text)) {
      return { className: "native-parser-memory", ceiling: "HIGH", proficiencyFit: 0.62, workflow, label: "memory corruption" };
    }
    if (languages.has("go") || languages.has("rust")) {
      return { className: "managed-parser-dos", ceiling: "LOW", proficiencyFit: 0.9, workflow, label: "DoS", onlyDos: true };
    }
    return { className: "parser-dos", ceiling: "MEDIUM", proficiencyFit: 0.72, workflow, label: "parser DoS" };
  }
  if (CRYPTO.test(text)) {
    return { className: "mature-crypto-core", ceiling: "CRITICAL", proficiencyFit: 0.08, workflow, label: "crypto break", tinyFindable: true };
  }
  if (workflow === "live-api") {
    return { className: "api-authz", ceiling: "HIGH", proficiencyFit: 0.82, workflow, label: "API authz" };
  }
  if (workflow === "live-web") {
    return { className: "web-business-logic", ceiling: "HIGH", proficiencyFit: 0.8, workflow, label: "web authz" };
  }
  return { className: "source-review", ceiling: "MEDIUM", proficiencyFit: 0.38, workflow, label: "source flaw" };
}

function recentScope(program, target, now) {
  if (program.change?.type === "baseline") return false;
  if (program.change?.type === "new_program") return true;
  if (program.change?.type === "new_target" && target.firstSeenAt === program.change.at) return true;
  const added = target.addedAt ?? target.firstSeenAt;
  const age = added ? daysBetween(added, now) : null;
  return age != null && age < 45 && program.change?.type !== "baseline";
}

function policyFloor(program, policySignals, settings) {
  const override = settings.programOverride ?? {};
  const value = override.programFloorSeverity
    ?? policySignals?.programFloorSeverity
    ?? program.programFloorSeverity
    ?? settings.unknownProgramFloor
    ?? "MEDIUM";
  return {
    value: severityName(value),
    source: override.programFloorSeverity
      ? "override"
      : policySignals?.programFloorSeverity
        ? policySignals.floorSource ?? "policy"
        : program.programFloorSeverity
          ? "source"
          : "conservative-default",
  };
}

function eligibilityFor(program, target, policySignals, settings, workflow) {
  const override = settings.programOverride ?? {};
  const country = String(settings.researcherCountry ?? "IN").toUpperCase();
  const excludedCountries = new Set([
    ...(policySignals?.excludedCountries ?? []),
    ...(override.excludedCountries ?? []),
  ].map((value) => String(value).toUpperCase()));
  const reasons = [];
  if (!program.paid) reasons.push("program is not confirmed paid");
  if (program.status !== "open") reasons.push("program is not open");
  if (target.eligible === false) reasons.push("target is not bounty eligible");
  if (override.eligible === false) reasons.push(override.eligibilityReason ?? "program override marks researcher ineligible");
  if (program.inviteOnly || policySignals?.inviteOnly || override.inviteOnly || /\b(?:invite[- ]only|invitational)\b/i.test(`${program.name} ${program.policyText ?? ""}`)) reasons.push("invite-only program");
  if (program.kycRequired || policySignals?.kycRequired || override.kycRequired) reasons.push("KYC required");
  if (excludedCountries.has(country)) reasons.push(`${country} researchers excluded`);
  const safeHarborNeeded = override.safeHarborRequired === true || policySignals?.safeHarborRequired === true;
  const safeHarborMissing = override.noSafeHarbor === true || policySignals?.noSafeHarbor === true;
  if (safeHarborNeeded && safeHarborMissing && workflow !== "static-source") reasons.push("required safe harbor is absent");
  return { eligible: reasons.length === 0, reasons };
}

function pFirstFor(program, settings, now) {
  const launchedAt = program.launchedAt ?? program.createdAt ?? null;
  const ageDays = launchedAt ? daysBetween(launchedAt, now) : null;
  const young = ageDays != null && ageDays < 90 ? 1 : 0;
  const rawReports = Number(program.resolvedReports ?? settings.unknownResolvedReports ?? 25);
  const resolvedReports = Number.isFinite(rawReports) ? Math.max(0, rawReports) : 25;
  const crowdTerm = resolvedReports === 0 ? 1 : Math.min(1, 1 / Math.log(1 + resolvedReports));
  return {
    value: round(clamp(0.2 + 0.5 * young + 0.3 * crowdTerm), 3),
    programAgeDays: ageDays == null ? null : round(ageDays, 1),
    resolvedReports,
    resolvedReportsEstimated: program.resolvedReports == null,
  };
}

function auditMatch(audited, program, target, repoSignals) {
  const programValues = [program.id?.replace(/^program:/, ""), program.name].filter(Boolean).map(norm);
  const repositoryValues = repoSignals || /github\.com|gitlab\.com/i.test(target.value ?? "")
    ? [target.value, repoSignals?.fullName].filter(Boolean).map(norm)
    : [];
  for (const [key, entry] of Object.entries(audited?.entries ?? audited ?? {})) {
    const aliases = [key, ...(entry.aliases ?? [])].map(norm).filter(Boolean);
    const programMatch = aliases.some((alias) => programValues.some((value) => value === alias || value.startsWith(`${alias} `)));
    const repositoryMatch = aliases.some((alias) => repositoryValues.some((value) => value === alias || value.includes(alias)));
    if (programMatch || repositoryMatch) {
      return { key, ...entry };
    }
  }
  return null;
}

function dormant(liveState, workflow) {
  if (workflow !== "live-contract" || liveState?.deployed !== true) return false;
  return liveState.tx30d === 0 || liveState.tvl === 0;
}

function reasonFor(candidate) {
  const parts = [];
  if (candidate.freshCodeIndex >= 50) parts.push("fresh code");
  else if (candidate.recentScope) parts.push("fresh scope");
  parts.push(candidate.workflow.replaceAll("-", " "));
  parts.push(`${candidate.classificationLabel} ceiling ${candidate.payableSeverityCeiling}`);
  if (candidate.repoSignals?.status === "ok") {
    if (candidate.hardeningIndex < 35) parts.push("low hardening signal");
    else if (candidate.hardeningIndex >= 60) parts.push("mature review surface");
  }
  if (!candidate.resolvedReportsEstimated && candidate.resolvedReports < 10) parts.push("low recorded crowd");
  if (candidate.repoSignals?.filesAdded90d > 0) parts.push(`${candidate.repoSignals.filesAdded90d} files added/90d`);
  return parts.slice(0, 5).join(" + ");
}

export function evaluateTarget(program, target, context = {}) {
  const now = context.now ?? new Date().toISOString();
  const repoSignals = context.repoSignals ?? target.repoSignals ?? null;
  const liveState = context.liveState ?? target.liveState ?? null;
  const policySignals = context.policySignals ?? null;
  const settings = context.settings ?? {};
  const classification = classifyFindable(program, target, repoSignals, liveState);
  const isRecentScope = recentScope(program, target, now);
  const hardeningIndex = calculateHardeningIndex(repoSignals, targetText(program, target, repoSignals));
  const freshCodeIndex = calculateFreshCodeIndex(repoSignals, { recentScope: isRecentScope });
  const knownIssueRisk = calculateKnownIssueRisk(repoSignals);
  const floor = policyFloor(program, policySignals, settings);
  const ceilingRank = severityRank(classification.ceiling);
  const floorRank = severityRank(floor.value);
  let workflow = classification.workflow;
  if (workflow === "static-source" && hardeningIndex >= 55 && freshCodeIndex < 40) workflow = "static-source-hardened";

  let pFindable = clamp(
    0.15
      + 0.45 * (freshCodeIndex / 100)
      + 0.30 * ((100 - hardeningIndex) / 100)
      + 0.10 * classification.proficiencyFit,
  );
  if (classification.tinyFindable) pFindable *= 0.2;
  if (workflow === "static-source-hardened") pFindable *= 0.45;
  if (workflow === "static-source" && freshCodeIndex < 50) {
    pFindable *= repoSignals?.status === "ok" ? 0.7 : 0.3;
  }
  pFindable = round(clamp(pFindable), 3);

  const eligibility = eligibilityFor(program, target, policySignals, settings, workflow);
  const pPayable = round((ceilingRank >= floorRank ? 1 : 0) * (1 - knownIssueRisk / 100) * (eligibility.eligible ? 1 : 0), 3);
  const first = pFirstFor(program, settings, now);
  const traps = [...new Set(repoSignals?.trapTags ?? [])];
  const exclude = [];

  if (classification.onlyDos && floorRank > SEVERITY.LOW) {
    traps.push("DOS_CEILING");
    exclude.push(`${classification.ceiling} DoS ceiling is below the ${floor.value} program floor`);
  } else if (ceilingRank < floorRank) {
    exclude.push(`${classification.ceiling} severity ceiling is below the ${floor.value} program floor`);
  }
  if (hardeningIndex > 70 && freshCodeIndex < 25) exclude.push("mature hardened source with little fresh code");
  if (knownIssueRisk >= 60) exclude.push("known-issue risk is 60 or higher");
  if (!eligibility.eligible) exclude.push(...eligibility.reasons);
  if (dormant(liveState, workflow)) {
    traps.push("DORMANT");
    exclude.push("deployed contract surface has zero recent use or value");
  }
  if ((repoSignals?.trapHits ?? []).length > 0 && !traps.includes("DEV_KNOWN")) traps.push("DEV_KNOWN");

  const audit = auditMatch(context.audited, program, target, repoSignals);
  const auditJump = audit ? freshCodeIndex - Number(audit.freshCodeIndexAtAudit ?? 0) : 0;
  if (audit && auditJump <= 40) exclude.push(`audited ${audit.verdict} target: ${audit.key}`);

  const rawEv = Math.max(0, Number(program.maxReward ?? 0)) * pFindable * pPayable * first.value;
  const candidate = {
    ...target,
    repoSignals,
    liveState: workflow === "live-contract" ? liveState : null,
    hardeningIndex,
    freshCodeIndex,
    knownIssueRisk,
    payableSeverityCeiling: classification.ceiling,
    programFloorSeverity: floor.value,
    programFloorSource: floor.source,
    workflow,
    findableClass: classification.className,
    classificationLabel: classification.label,
    pFindable,
    pPayable,
    pFirst: first.value,
    evScore: exclude.length ? 0 : round(rawEv, 2),
    traps: [...new Set(traps)],
    excludeReason: exclude.length ? [...new Set(exclude)].join("; ") : null,
    recentScope: isRecentScope,
    programAgeDays: first.programAgeDays,
    resolvedReports: first.resolvedReports,
    resolvedReportsEstimated: first.resolvedReportsEstimated,
    audit: audit ? { key: audit.key, verdict: audit.verdict, date: audit.date, freshJump: round(auditJump, 1) } : null,
  };
  candidate.reason = reasonFor(candidate);
  return candidate;
}

export function evaluateProgram(program, context = {}) {
  const targetContexts = context.targetContexts ?? new Map();
  const candidates = (program.targets ?? []).map((target) => {
    const perTarget = targetContexts.get(target.key) ?? {};
    return evaluateTarget(program, target, {
      ...context,
      ...perTarget,
      settings: { ...(context.settings ?? {}), ...(perTarget.settings ?? {}) },
    });
  });

  if (candidates.length === 0) {
    candidates.push(evaluateTarget(program, {
      key: `${program.id}:policy`,
      type: program.tags?.includes("api") ? "api" : "web",
      value: program.url,
      eligible: true,
    }, context));
  }

  const ranked = [...candidates].sort((a, b) => b.evScore - a.evScore || b.pFindable - a.pFindable);
  const best = ranked.find((candidate) => !candidate.excludeReason) ?? ranked[0];
  const surviving = ranked.filter((candidate) => !candidate.excludeReason);
  const excludeReason = surviving.length ? null : best.excludeReason ?? "no payable target survived the hard filters";
  return {
    ...program,
    targets: candidates,
    hardeningIndex: best.hardeningIndex,
    freshCodeIndex: best.freshCodeIndex,
    knownIssueRisk: best.knownIssueRisk,
    payableSeverityCeiling: best.payableSeverityCeiling,
    programFloorSeverity: best.programFloorSeverity,
    programFloorSource: best.programFloorSource,
    workflow: best.workflow,
    findableClass: best.findableClass,
    pFindable: best.pFindable,
    pPayable: best.pPayable,
    pFirst: best.pFirst,
    evScore: excludeReason ? 0 : best.evScore,
    traps: best.traps,
    repoSignals: best.repoSignals,
    liveState: best.liveState,
    excludeReason,
    reasons: [best.reason],
    honestReason: best.reason,
    bestTargetKey: best.key,
  };
}

export function rankPrograms(programs, contextFactory = () => ({})) {
  return programs
    .map((program) => evaluateProgram(program, contextFactory(program)))
    .sort((a, b) => {
      if (Boolean(a.excludeReason) !== Boolean(b.excludeReason)) return a.excludeReason ? 1 : -1;
      return b.evScore - a.evScore || b.pFindable - a.pFindable || a.name.localeCompare(b.name);
    });
}

export const severity = SEVERITY;

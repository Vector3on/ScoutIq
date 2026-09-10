// HYPOTHESIZE — step 2 of the hybrid loop (the semantic/LLM step).
//
// For each candidate location, match source against the {scenario, property}
// template library and emit ranked candidates with exact file/line and the
// property to check. This is deliberately high-recall: the LLM (or the offline
// matcher) PROPOSES; it never confirms. Confirmation is the deterministic tool
// step — LLM-alone is high false-positive, so we do not stop here.
//
// Three providers:
//   - deterministic: offline signal matcher (no network, no key). The default.
//   - anthropic:     Claude Messages API over raw fetch (opt-in, needs a key).
//   - command:       an operator-supplied program that returns candidate JSON.
//
// The anthropic/command providers are *seeded* by the deterministic matcher so
// the model focuses on plausible files, and both fall back to the deterministic
// result on any error — an LLM outage degrades recall, never correctness.

import { sha256, truncate } from "./io.mjs";
import { templatesFor } from "./templates.mjs";

const SEVERITY_WEIGHT = { CRITICAL: 1.0, HIGH: 0.7, MEDIUM: 0.4, LOW: 0.2, INFORMATIVE: 0.1 };

export function candidateId({ templateId, file, line, vulnClass }) {
  return sha256(`${templateId}:${file}:${line}:${vulnClass}`).slice(0, 16);
}

function windowText(lines, index, radius) {
  const start = Math.max(0, index - radius);
  const end = Math.min(lines.length, index + radius + 1);
  return lines.slice(start, end).join("\n");
}

function anyMatch(compiledList, text) {
  return compiledList.some((entry) => entry.regex.test(text));
}

function firstMatch(compiledList, text) {
  for (const entry of compiledList) {
    if (entry.regex.test(text)) return entry.source;
  }
  return null;
}

// Deterministic matcher: scan every scoped file line-by-line against every
// stack-applicable template. Emits one candidate per (template, file, line).
export function deterministicMatch({ sources, library, activeStacks, vulnClasses = [], maxCandidates = 40 }) {
  const candidates = [];
  const seen = new Set();

  for (const source of sources) {
    if (!activeStacks.includes(source.stack)) continue;
    const templates = templatesFor(library, source.stack, vulnClasses);
    if (!templates.length) continue;
    const lines = source.text.split(/\r?\n/);

    for (const template of templates) {
      const { sink, any, source: taint, negate, contextWindow } = template.compiled;
      const primary = sink.length ? sink : any;
      if (!primary.length) continue;

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const matchedSignal = firstMatch(primary, line);
        if (!matchedSignal) continue;

        const context = windowText(lines, i, contextWindow);
        if (negate.length && anyMatch(negate, context)) continue; // looks already-mitigated
        if (sink.length && any.length && !anyMatch(any, context)) continue; // sink present but no interpolation/danger marker nearby

        const key = `${template.id}:${source.path}:${i + 1}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const hasTaint = taint.length ? anyMatch(taint, context) : false;
        let score = 1.0;
        score += hasTaint ? 1.5 : 0;
        score += SEVERITY_WEIGHT[String(template.severityHint ?? "MEDIUM").toUpperCase()] ?? 0.4;
        if (any.length) score += 0.2;

        candidates.push({
          id: candidateId({ templateId: template.id, file: source.path, line: i + 1, vulnClass: template.vulnClass }),
          templateId: template.id,
          vulnClass: template.vulnClass,
          stack: source.stack,
          file: source.path,
          line: i + 1,
          snippet: truncate(line.trim(), 200),
          property: template.property,
          scenario: template.scenario,
          confirmers: template.confirmers,
          poc: template.poc ?? "script",
          severityHint: template.severityHint ?? "MEDIUM",
          q1Template: template.q1 ?? "",
          matchedSignal,
          taintNearby: hasTaint,
          score: Math.round(score * 1000) / 1000,
          rationale: `Signal "${matchedSignal}" matched${hasTaint ? " with a request-input source nearby" : ""}; property to confirm: ${template.property}`,
          proposedBy: "deterministic",
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
  return candidates.slice(0, maxCandidates);
}

// Map a raw LLM/command candidate onto the grounded shape, validating that the
// referenced file exists and the line is in range. Attaches the template by id
// (preferred) or by vulnClass for the stack.
function groundRawCandidate(raw, { sourceByPath, library, activeStacks }) {
  const file = String(raw.file ?? raw.path ?? "").replace(/^\.?\//, "");
  const source = sourceByPath.get(file);
  if (!source || !activeStacks.includes(source.stack)) return null;

  const lines = source.text.split(/\r?\n/);
  const line = Math.min(Math.max(1, Math.trunc(Number(raw.line ?? 1)) || 1), lines.length);

  let template = raw.templateId ? library.templates.find((entry) => entry.id === raw.templateId) : null;
  if (!template && raw.vulnClass) {
    template = templatesFor(library, source.stack).find((entry) => String(entry.vulnClass).toLowerCase() === String(raw.vulnClass).toLowerCase());
  }
  if (!template) return null;

  const confidence = Number.isFinite(Number(raw.confidence)) ? Math.min(1, Math.max(0, Number(raw.confidence))) : 0.6;
  const score = Math.round((1 + confidence * 2 + (SEVERITY_WEIGHT[String(template.severityHint ?? "MEDIUM").toUpperCase()] ?? 0.4)) * 1000) / 1000;

  return {
    id: candidateId({ templateId: template.id, file, line, vulnClass: template.vulnClass }),
    templateId: template.id,
    vulnClass: template.vulnClass,
    stack: source.stack,
    file,
    line,
    snippet: truncate((lines[line - 1] ?? "").trim(), 200),
    property: template.property,
    scenario: template.scenario,
    confirmers: template.confirmers,
    poc: template.poc ?? "script",
    severityHint: template.severityHint ?? "MEDIUM",
    q1Template: template.q1 ?? "",
    matchedSignal: "llm",
    taintNearby: undefined,
    score,
    rationale: truncate(String(raw.rationale ?? raw.reason ?? "LLM-proposed candidate"), 400),
    proposedBy: raw.proposedBy ?? "llm",
  };
}

// Choose which files the LLM sees: matcher-flagged files first, then the
// smallest remaining files, bounded by count and a character budget.
function selectFilesForLlm(sources, seedCandidates, { maxFiles = 10, charBudget = 120_000 }) {
  const flagged = new Set(seedCandidates.map((candidate) => candidate.file));
  const ordered = [...sources].sort((a, b) => {
    const af = flagged.has(a.path) ? 0 : 1;
    const bf = flagged.has(b.path) ? 0 : 1;
    return af - bf || a.text.length - b.text.length;
  });
  const chosen = [];
  let budget = charBudget;
  for (const source of ordered) {
    if (chosen.length >= maxFiles) break;
    if (source.text.length > budget && chosen.length > 0) continue;
    chosen.push(source);
    budget -= source.text.length;
  }
  return chosen;
}

function numberLines(text) {
  return text.split(/\r?\n/).map((line, index) => `${index + 1}: ${line}`).join("\n");
}

function buildCatalog(library, activeStacks) {
  const entries = library.templates.filter((template) => template.stacks.some((stack) => activeStacks.includes(stack)));
  return entries.map((template) => `- ${template.id} [${template.vulnClass}] scenario: ${template.scenario} | property: ${template.property}`).join("\n");
}

function extractJsonArray(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

const PROPOSE_SYSTEM = [
  "You are the hypothesis stage of a hybrid vulnerability verification loop.",
  "You PROPOSE candidate vulnerabilities for deterministic tools to confirm later; you never confirm anything yourself.",
  "Favor recall: surface every plausible match to a scenario, even if unsure — downstream tools kill false positives.",
  "Only reference files and line numbers that appear in the provided source. Do not invent paths or lines.",
  "Respond with ONLY a JSON array. Each element: {\"file\": string, \"line\": number, \"vulnClass\": string, \"templateId\": string, \"confidence\": number 0..1, \"rationale\": string}.",
].join(" ");

function buildPrompt({ catalog, files }) {
  const fileBlocks = files
    .map((source) => `FILE: ${source.path} (stack: ${source.stack})\n${numberLines(truncate(source.text, 40_000))}`)
    .join("\n\n");
  return [
    "TEMPLATE CATALOG (scenario -> property):",
    catalog,
    "",
    "SOURCE FILES (line-numbered):",
    fileBlocks,
    "",
    "Return the JSON array of candidate locations now.",
  ].join("\n");
}

// Anthropic Messages API via raw fetch — consistent with the pipeline's
// zero-dependency, fetch-based network posture (see scripts/collect.mjs). The
// model is the analysis engine reading locally-cloned source; it is not a
// target, so this respects the clean-lane boundary.
async function callAnthropic({ config, catalog, files, env, fetchImpl }) {
  const settings = config.hypothesizer.anthropic ?? {};
  const apiKey = env[settings.apiKeyEnv ?? "ANTHROPIC_API_KEY"];
  if (!apiKey) return { ok: false, reason: `no API key in env ${settings.apiKeyEnv ?? "ANTHROPIC_API_KEY"}` };

  const body = {
    model: settings.model ?? "claude-opus-5",
    max_tokens: settings.maxTokens ?? 16_000,
    system: PROPOSE_SYSTEM,
    messages: [{ role: "user", content: buildPrompt({ catalog, files }) }],
  };

  let response;
  try {
    response = await fetchImpl(`${(settings.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    return { ok: false, reason: `request failed: ${String(error?.message ?? error)}` };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { ok: false, reason: `HTTP ${response.status} ${truncate(detail, 200)}` };
  }

  const payload = await response.json().catch(() => null);
  if (payload?.stop_reason === "refusal") return { ok: false, reason: "model refusal" };
  const text = Array.isArray(payload?.content)
    ? payload.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")
    : "";
  const parsed = extractJsonArray(text);
  if (!parsed) return { ok: false, reason: "no JSON array in model response" };
  return { ok: true, raw: parsed };
}

async function callCommand({ config, catalog, files, runCommandImpl }) {
  const argv = config.hypothesizer.command?.argv ?? [];
  if (!argv.length) return { ok: false, reason: "no command argv configured" };
  const request = JSON.stringify({
    task: "propose-vulnerability-candidates",
    instructions: PROPOSE_SYSTEM,
    catalog,
    files: files.map((source) => ({ path: source.path, stack: source.stack, text: truncate(source.text, 40_000) })),
  });
  const result = await runCommandImpl(argv[0], argv.slice(1), { input: request, timeoutMs: 180_000 });
  if (!result.ok) return { ok: false, reason: `command failed: ${truncate(result.stderr || result.stdout, 200)}` };
  const parsed = extractJsonArray(result.stdout);
  if (!parsed) return { ok: false, reason: "command produced no JSON array" };
  return { ok: true, raw: parsed };
}

// Dispatcher. Returns { candidates, provider, fellBack, warnings }.
export async function hypothesize(config, { sources, library, activeStacks, env = process.env, fetchImpl, runCommandImpl }) {
  const vulnClasses = config.vulnClasses ?? [];
  const maxCandidates = config.hypothesizer?.maxCandidates ?? 40;
  const provider = config.hypothesizer?.provider ?? "deterministic";
  const warnings = [];

  const seed = deterministicMatch({ sources, library, activeStacks, vulnClasses, maxCandidates });

  if (provider === "deterministic") {
    return { candidates: seed, provider: "deterministic", fellBack: false, warnings };
  }

  const sourceByPath = new Map(sources.map((source) => [source.path, source]));
  const catalog = buildCatalog(library, activeStacks);
  const files = selectFilesForLlm(sources, seed, {
    maxFiles: config.hypothesizer?.anthropic?.maxFilesPerBatch ?? 10,
  });

  let llm;
  if (provider === "anthropic") {
    llm = await callAnthropic({ config, catalog, files, env, fetchImpl: fetchImpl ?? globalThis.fetch });
  } else {
    const { runCommand } = await import("./io.mjs");
    llm = await callCommand({ config, catalog, files, runCommandImpl: runCommandImpl ?? runCommand });
  }

  if (!llm.ok) {
    warnings.push(`hypothesizer "${provider}" unavailable (${llm.reason}); fell back to the deterministic matcher.`);
    return { candidates: seed, provider: `${provider}-fallback`, fellBack: true, warnings };
  }

  const grounded = [];
  const dedupe = new Set();
  for (const raw of llm.raw) {
    const candidate = groundRawCandidate({ ...raw, proposedBy: provider }, { sourceByPath, library, activeStacks });
    if (!candidate || dedupe.has(candidate.id)) continue;
    dedupe.add(candidate.id);
    grounded.push(candidate);
  }

  if (!grounded.length) {
    warnings.push(`hypothesizer "${provider}" returned no groundable candidates; fell back to the deterministic matcher.`);
    return { candidates: seed, provider: `${provider}-fallback`, fellBack: true, warnings };
  }

  grounded.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
  return { candidates: grounded.slice(0, maxCandidates), provider, fellBack: false, warnings };
}

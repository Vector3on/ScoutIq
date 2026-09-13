// The {scenario, property} template library.
//
// Each template pairs a *semantic scenario* (what the LLM step looks for) with a
// *checkable property* (the invariant a deterministic tool must confirm), plus
// greppable `signals` the offline matcher uses to locate candidates, and the
// `confirmers` that can prove the property. The library is seeded from the
// 100-area methodology and is extensible — add entries to
// config/verify-templates.json without touching code.

import { resolve } from "node:path";
import { readJson } from "./io.mjs";

const REQUIRED_FIELDS = ["id", "vulnClass", "stacks", "scenario", "property", "confirmers"];

// Minimal built-in fallback so the module still runs if the JSON file is absent.
const BUILTIN = {
  version: 1,
  methodology: "100-area (built-in fallback)",
  templates: [
    {
      id: "sol-reentrancy",
      vulnClass: "reentrancy",
      stacks: ["solidity"],
      severityHint: "HIGH",
      scenario: "A function performs an external call or value transfer before committing the state that guards it.",
      property: "All guarding state is written before the external interaction, or the function carries a non-reentrant guard.",
      signals: { sink: ["\\.call\\{value", "\\.call\\(", "\\.transfer\\(", "\\.send\\("], negate: ["nonReentrant", "ReentrancyGuard"], contextWindow: 30 },
      confirmers: ["slither", "foundry", "echidna"],
      poc: "foundry",
      q1: "Re-enter the function from an attacker fallback before the first call returns and assert the accounting invariant breaks.",
    },
    {
      id: "web-sql-injection",
      vulnClass: "sql-injection",
      stacks: ["js-ts", "python", "php", "go"],
      severityHint: "HIGH",
      scenario: "User-controlled input is concatenated or interpolated into a SQL statement instead of being bound as a parameter.",
      property: "The query's structure is fixed; all user input reaches the database only through bound parameters (no taint path from request input to the query string).",
      signals: {
        sink: ["execute\\(", "\\.query\\(", "mysqli_query", "db\\.Query", "db\\.Exec"],
        source: ["req\\.", "request\\.", "\\$_(GET|POST|REQUEST|COOKIE)", "ctx\\.Query", "r\\.URL"],
        any: ["SELECT ", "INSERT ", "UPDATE ", "DELETE "],
        contextWindow: 4,
      },
      confirmers: ["semgrep", "codeql", "runtime-harness"],
      poc: "http-request",
      q1: "Send a boolean/time-based differential payload to the endpoint against the LOCAL instance and observe divergent responses.",
    },
  ],
};

export function validateTemplate(template) {
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (template[field] == null) errors.push(`missing ${field}`);
  }
  if (template.stacks && !Array.isArray(template.stacks)) errors.push("stacks must be an array");
  if (template.confirmers && !Array.isArray(template.confirmers)) errors.push("confirmers must be an array");
  return errors;
}

function compileList(patterns) {
  const compiled = [];
  for (const pattern of patterns ?? []) {
    try {
      compiled.push({ source: pattern, regex: new RegExp(pattern, "i") });
    } catch {
      // Skip an invalid pattern rather than failing the whole run.
    }
  }
  return compiled;
}

// Precompile a template's signals into RegExp bundles the matcher can reuse.
export function compileTemplate(template) {
  const signals = template.signals ?? {};
  return {
    ...template,
    compiled: {
      sink: compileList(signals.sink),
      any: compileList(signals.any),
      source: compileList(signals.source),
      negate: compileList(signals.negate),
      contextWindow: Number.isFinite(signals.contextWindow) ? signals.contextWindow : 6,
    },
  };
}

export async function loadTemplates({ root, templatesPath }) {
  const raw = templatesPath ? await readJson(resolve(root, templatesPath), null) : null;
  const library = raw && Array.isArray(raw.templates) ? raw : BUILTIN;

  const seen = new Set();
  const valid = [];
  const rejected = [];
  for (const template of library.templates) {
    const errors = validateTemplate(template);
    if (errors.length || seen.has(template.id)) {
      rejected.push({ id: template?.id ?? "(unknown)", errors: seen.has(template?.id) ? [...errors, "duplicate id"] : errors });
      continue;
    }
    seen.add(template.id);
    valid.push(compileTemplate(template));
  }

  return {
    version: library.version ?? 1,
    methodology: library.methodology ?? "unspecified",
    source: raw ? templatesPath : "built-in fallback",
    templates: valid,
    rejected,
  };
}

// Select the templates that apply to a stack, optionally filtered to a set of
// vuln classes (empty set = all classes).
export function templatesFor(library, stack, vulnClasses = []) {
  const classFilter = new Set((vulnClasses ?? []).map((value) => String(value).toLowerCase()));
  return library.templates.filter((template) => {
    if (!template.stacks.includes(stack)) return false;
    if (classFilter.size && !classFilter.has(String(template.vulnClass).toLowerCase())) return false;
    return true;
  });
}

export function allVulnClasses(library) {
  return [...new Set(library.templates.map((template) => template.vulnClass))].sort();
}

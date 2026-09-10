// Renders audit seeds as a disciplined Markdown worksheet.
//
// The report is built around the 7-Question Gate (methodology item 95). Every
// seed is printed as a KILL-by-default worksheet entry: you either fill in Q1
// (the exact copy-paste attacker request) and confirm it live, or you strike
// the seed. Seeds are not findings.

const SEVEN_QUESTIONS = [
  "Q1. Exact attacker request (copy-paste). No request ⇒ KILL.",
  "Q2. What identity/scope is required, and do you have it in-scope?",
  "Q3. What is the concrete impact (who loses what)?",
  "Q4. Reproduced live on an in-scope asset? (seed-and-stop until yes)",
  "Q5. Honest severity in your own words (not the ceiling).",
  "Q6. Already reported / easy to find on a crowded target? (dedup)",
  "Q7. Permalink pinned to the commit + minimal PoC.",
];

function confidenceBadge(confidence) {
  return { high: "HIGH", medium: "MED", low: "LOW" }[confidence] ?? "LOW";
}

export function renderMarkdown({ seeds, summary, coverage, meta = {} }) {
  const lines = [];
  const now = meta.now ?? new Date().toISOString();

  lines.push(`# Source-audit worksheet — ${meta.engagement ?? "unnamed engagement"}`);
  lines.push("");
  lines.push(`- Generated: ${now}`);
  lines.push(`- Path scanned: \`${meta.path ?? "."}\``);
  lines.push(`- Files scanned: ${meta.filesScanned ?? "?"} · Seeds: ${summary.total} (across ${summary.distinctItems} methodology items)`);
  lines.push("");
  lines.push("> **Seeds are not findings.** Each entry below is a candidate. Work the 7-Question Gate; if Q1 cannot be written against an **in-scope** asset, strike it. The official program policy — not this repo — controls authorization.");
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push(`| Confidence | Count |  | Priority | Count |`);
  lines.push(`|---|---|---|---|---|`);
  lines.push(`| high | ${summary.byConfidence.high ?? 0} |  | P1 | ${summary.byPriority.P1 ?? 0} |`);
  lines.push(`| medium | ${summary.byConfidence.medium ?? 0} |  | P2 | ${summary.byPriority.P2 ?? 0} |`);
  lines.push(`| low | ${summary.byConfidence.low ?? 0} |  | P3 | ${summary.byPriority.P3 ?? 0} |`);
  lines.push("");

  if (coverage) {
    lines.push("## Methodology coverage");
    lines.push("");
    lines.push(`- Automated (SRC seeds): **${coverage.automatedItems}** of ${coverage.totalItems} items.`);
    lines.push(`- Handed to the live / manual lane: **${coverage.manualItems}** items (recon, live business logic, live XSS, MFA, races, etc.). These need a human on an authorized target — seed-and-stop (item 96).`);
    lines.push("");
  }

  lines.push("## The 7-Question Gate");
  lines.push("");
  for (const q of SEVEN_QUESTIONS) lines.push(`- ${q}`);
  lines.push("");

  lines.push("## Seeds (ranked; KILL by default)");
  lines.push("");
  if (seeds.length === 0) {
    lines.push("_No seeds. Log the empty result honestly (item 100) and move to the next fresh target._");
    lines.push("");
  }

  let currentSection = null;
  let n = 0;
  for (const seed of seeds) {
    if (seed.section !== currentSection) {
      currentSection = seed.section;
      lines.push(`### ${currentSection}`);
      lines.push("");
    }
    n += 1;
    const cwe = seed.cwe.length ? ` · ${seed.cwe.join(", ")}` : "";
    lines.push(`#### ${n}. [${confidenceBadge(seed.confidence)} · ${seed.priority}] ${seed.title}`);
    lines.push("");
    lines.push(`- **Where:** \`${seed.path}:${seed.line}\``);
    lines.push(`- **Methodology:** item ${seed.item} — ${seed.methodologyTitle}${cwe}`);
    lines.push(`- **Why flagged:** ${seed.rationale}`);
    if (seed.evidence) lines.push(`- **Evidence:** ${seed.evidence}`);
    lines.push(`- **Code:** \`${seed.snippet.replace(/`/g, "'")}\``);
    lines.push(`- **KILL unless:** ${seed.killUnless || "confirmed exploitable and in-scope."}`);
    lines.push(`- **Q1 (write it or KILL):** ${seed.q1}`);
    lines.push("  - [ ] Q1 written  · [ ] Reproduced live in-scope  · [ ] Severity: ____  · [ ] Deduped  · [ ] Permalink");
    lines.push("");
  }

  lines.push("---");
  lines.push("_Discipline: scope is law (97) · honest severity + commit permalink (98) · dedup (99) · honest base rate — most reviews find nothing (100)._");
  lines.push("");
  return lines.join("\n");
}

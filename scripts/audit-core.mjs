// ScoutIQ source-audit engine.
//
// Runs the SRC-lane detectors from audit/detectors.json over source text and
// emits SEEDS (not findings). A seed is a candidate that still has to pass the
// Q1 gate — "write the exact copy-paste attacker request or KILL it" — before it
// becomes a report. Nothing here touches the network or a live target.
//
// Pure and string-first by design: every function takes text in and returns
// data out, so the whole engine is unit-testable without a filesystem. The CLI
// (audit.mjs) owns the disk walking.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const CONFIDENCE_WEIGHT = Object.freeze({ high: 1.0, medium: 0.6, low: 0.3 });
const PRIORITY_WEIGHT = Object.freeze({ P1: 1.0, P2: 0.6, P3: 0.3, "—": 0.2 });
const CONFIDENCE_RANK = Object.freeze({ high: 3, medium: 2, low: 1 });

// Values that look like secrets but are inert. Case-insensitive substring test.
const PLACEHOLDER_HINTS = [
  "example", "changeme", "change_me", "placeholder", "your_", "your-", "yourkey",
  "xxxx", "dummy", "sample", "test_", "testkey", "redacted", "<", "insert", "todo",
  "fake", "notreal", "00000000", "1234567", "abcdef", "deadbeef", "sk_test",
];

// Security-relevant context for weak-RNG. Deliberately excludes bare "api" and
// substring "key" (which matched array_keys, monkey, etc.); keeps \bkey\b and
// compound apiKey/privateKey so camelCase secrets still hit.
const SECRET_CONTEXT = /(token|secret|nonce|\botp\b|password|passwd|salt|\biv\b|session|reset|csrf|credential|\bkey\b|api[_-]?key|private[_-]?key|signing|signature|cookie)/i;
const NON_CRYPTO_INTENT = /not\s+for\s+crypto|non[-\s]?crypto|not\s+cryptograph|insecure\s+random\s+ok/i;
const SAFE_COMPARE = /(timingSafeEqual|compare_digest|constant[_-]?time|constantTime|hash_equals|MessageDigest\.isEqual|subtle\.)/i;
// A secret used as a VALUE next to a compare — not a function call like
// datasetSignature(x) (content hashing), which the negative lookahead excludes.
const SECRET_VALUE = /(hmac|signature|\bsig\b|digest|\bmac\b|token|secret|password|api[_-]?key|checksum|\bhash\b)(?!\w*\s*\()/i;

export function extToLang(ext) {
  const e = String(ext ?? "").replace(/^\./, "").toLowerCase();
  const map = {
    js: "js", jsx: "js", mjs: "js", cjs: "js",
    ts: "ts", tsx: "ts",
    py: "py", rb: "rb", php: "php", java: "java", go: "go", cs: "cs", rs: "rs",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
    kt: "kt", swift: "swift", json: "json", yml: "yaml", yaml: "yaml", env: "env",
  };
  return map[e] ?? e;
}

export function detectorApplies(detector, lang) {
  const langs = detector.langs ?? ["*"];
  return langs.includes("*") || langs.includes(lang);
}

// Shannon entropy in bits/char — used to separate real secrets from short/repetitive placeholders.
export function shannonEntropy(value) {
  const str = String(value ?? "");
  if (str.length === 0) return 0;
  const counts = new Map();
  for (const ch of str) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / str.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function looksLikePlaceholder(text) {
  const lower = String(text ?? "").toLowerCase();
  return PLACEHOLDER_HINTS.some((hint) => lower.includes(hint));
}

// Map a character offset to 1-based line/column and return the trimmed line text.
function locate(text, index, lineStarts) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  const line = lo + 1;
  const col = index - lineStarts[lo] + 1;
  const end = lineStarts[lo + 1] ?? text.length;
  const snippet = text.slice(lineStarts[lo], end).replace(/\s+$/, "");
  return { line, col, snippet };
}

function computeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

// Redact obvious secret material before a snippet ever leaves the engine, so the
// audit output itself is not a place secrets leak (methodology item 63).
export function redactSnippet(snippet, maxLength = 200) {
  let out = String(snippet ?? "").trim();
  out = out
    .replace(/(AKIA[0-9A-Z]{4})[0-9A-Z]{12}/g, "$1…REDACTED")
    .replace(/(sk_live_[0-9a-zA-Z]{4})[0-9a-zA-Z]{16,}/g, "$1…REDACTED")
    .replace(/(gh[pousr]_[0-9A-Za-z]{4})[0-9A-Za-z]{32,}/g, "$1…REDACTED")
    .replace(/(AIza[0-9A-Za-z_-]{4})[0-9A-Za-z_-]{31}/g, "$1…REDACTED")
    .replace(/(eyJ[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+/g, "$1…REDACTED.JWT")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "-----BEGIN … PRIVATE KEY (REDACTED)-----");
  if (out.length > maxLength) out = `${out.slice(0, maxLength)}…`;
  return out;
}

function isMinifiedOrLong(text) {
  if (text.length === 0) return false;
  const newlines = (text.match(/\n/g) ?? []).length + 1;
  const avgLineLength = text.length / newlines;
  return avgLineLength > 400 || text.length > 2_000_000;
}

// ---- function detectors -------------------------------------------------

function fnPostMessageMissingOrigin(text, lineStarts) {
  const seeds = [];
  const listener = /addEventListener\(\s*['"]message['"]|onmessage\s*=|\.on\(\s*['"]message['"]/g;
  const lines = text.split("\n");
  let match;
  while ((match = listener.exec(text)) !== null) {
    const at = locate(text, match.index, lineStarts);
    const windowText = lines.slice(at.line - 1, at.line - 1 + 30).join("\n");
    if (!/\.origin\b|event\.origin|\borigin\s*(===|==|!==|!=)|checkOrigin|verifyOrigin|ALLOWED_ORIGIN/i.test(windowText)) {
      seeds.push({ ...at, evidence: "message listener with no event.origin check in the following 30 lines" });
    }
  }
  return seeds;
}

function fnWeakRandomForSecret(text, lineStarts) {
  const seeds = [];
  const weak = /Math\.random\s*\(|\brandom\.(random|randint|choice|randrange)\s*\(|\bmt_rand\s*\(|(?<![A-Za-z])rand\s*\(\)|new Random\s*\(/g;
  const lines = text.split("\n");
  let match;
  while ((match = weak.exec(text)) !== null) {
    const at = locate(text, match.index, lineStarts);
    const context = lines.slice(Math.max(0, at.line - 5), at.line + 4).join("\n");
    if (SECRET_CONTEXT.test(context) && !NON_CRYPTO_INTENT.test(context)) {
      seeds.push({ ...at, evidence: "weak RNG within 4 lines of a token/secret/key/nonce context" });
    }
  }
  return seeds;
}

function fnTimingUnsafeSecretCompare(text) {
  const seeds = [];
  const lines = text.split("\n");
  const cmp = /(===|!==|==|!=)/g;
  const SEP = /&&|\|\||[,;{}?]|=>/; // logical/statement separators bounding an operand
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("#")) continue;
    if (SAFE_COMPARE.test(line)) continue;
    let flagged = false;
    if (/\.equals\s*\(/.test(line) && SECRET_VALUE.test(line)) {
      flagged = true;
    } else {
      cmp.lastIndex = 0;
      let m;
      while ((m = cmp.exec(line)) !== null) {
        // Isolate the two operands of THIS compare (bounded by && || , ; etc.) so
        // `provider === "github" && githubToken` (token unrelated) is not a hit,
        // while parens stay intact so datasetSignature(x) is excluded as a call.
        const left = line.slice(0, m.index).split(SEP).pop();
        const right = line.slice(m.index + m[0].length).split(SEP)[0];
        if (SECRET_VALUE.test(left) || SECRET_VALUE.test(right)) { flagged = true; break; }
      }
    }
    if (flagged) {
      seeds.push({ line: i + 1, col: 1, snippet: line.replace(/\s+$/, ""), evidence: "secret/HMAC compared with a non-constant-time operator" });
    }
  }
  return seeds;
}

function fnMissingReturnAfterAuthFailure(text) {
  const seeds = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isFail = /res\.status\(\s*40[13]\s*\)|res\.sendStatus\(\s*40[13]\s*\)|reply\.code\(\s*40[13]\s*\)/.test(line);
    if (!isFail) continue;
    if (/\breturn\b|\bthrow\b|=>/.test(line)) continue; // returned/thrown/arrow-bodied is fine
    const next = (lines[i + 1] ?? "").trim();
    if (/^return\b|^\}|^\)|^next\(/.test(next)) continue; // block ends right after
    seeds.push({ line: i + 1, col: 1, snippet: line.replace(/\s+$/, ""), evidence: "401/403 emitted without return/throw; execution may fall through" });
  }
  return seeds;
}

const FN_DETECTORS = Object.freeze({
  postMessageMissingOrigin: fnPostMessageMissingOrigin,
  weakRandomForSecret: fnWeakRandomForSecret,
  timingUnsafeSecretCompare: fnTimingUnsafeSecretCompare,
  missingReturnAfterAuthFailure: fnMissingReturnAfterAuthFailure,
});

// ---- rule loading & scanning -------------------------------------------

export function indexMethodology(methodology) {
  const byId = new Map();
  for (const item of methodology.items ?? []) byId.set(item.id, item);
  return byId;
}

export async function loadRules(root) {
  const auditDir = resolve(root, "audit");
  const [methodology, detectors] = await Promise.all([
    readFile(resolve(auditDir, "methodology.json"), "utf8").then(JSON.parse),
    readFile(resolve(auditDir, "detectors.json"), "utf8").then(JSON.parse),
  ]);
  return { methodology, detectors, methodologyById: indexMethodology(methodology) };
}

function buildSeed(detector, item, hit, path) {
  return {
    detectorId: detector.id,
    item: detector.item,
    section: item?.section ?? "unknown",
    title: detector.title,
    methodologyTitle: item?.title ?? "",
    priority: item?.priority ?? "P3",
    lane: item?.lane ?? "SRC",
    cwe: item?.cwe ?? [],
    confidence: hit.confidence ?? detector.confidence ?? "low",
    path,
    line: hit.line,
    col: hit.col ?? 1,
    snippet: redactSnippet(hit.snippet),
    evidence: hit.evidence ?? null,
    rationale: detector.rationale ?? "",
    killUnless: detector.killUnless ?? "",
    q1: item?.q1 ?? "Write the exact copy-paste attacker request, or KILL this seed.",
  };
}

// Scan one file's text with every applicable detector. Returns an array of seeds.
export function scanText({ path, text, lang, detectors, methodologyById }) {
  if (typeof text !== "string" || text.length === 0) return [];
  if (isMinifiedOrLong(text)) return []; // skip bundles/minified — noise, not source
  const lineStarts = computeLineStarts(text);
  const seeds = [];

  for (const detector of detectors.detectors ?? []) {
    if (!detectorApplies(detector, lang)) continue;
    const item = methodologyById.get(detector.item);

    if (detector.type === "fn") {
      const fn = FN_DETECTORS[detector.fn];
      if (!fn) continue;
      for (const hit of fn(text, lineStarts)) {
        seeds.push(buildSeed(detector, item, { ...hit, confidence: detector.confidence }, path));
      }
      continue;
    }

    // regex detector. JS RegExp has no inline (?i) modifier, so translate a
    // leading/embedded (?i) into the native `i` flag before compiling.
    let re;
    try {
      let pattern = detector.pattern;
      let flags = detector.flags ?? "";
      if (/\(\?i\)/.test(pattern)) {
        pattern = pattern.replace(/\(\?i\)/g, "");
        if (!flags.includes("i")) flags += "i";
      }
      if (!flags.includes("g")) flags += "g";
      re = new RegExp(pattern, flags);
    } catch {
      continue; // a malformed pattern should never crash a scan
    }
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match.index === re.lastIndex) re.lastIndex += 1; // guard zero-width
      const matchedText = match[0];
      if ((detector.allowlist ?? []).some((allowed) => matchedText.includes(allowed))) continue;

      const at = locate(text, match.index, lineStarts);
      let confidence = detector.confidence ?? "low";

      // Entropy gate for the noisy generic-credential detector.
      if (detector.entropyBoost) {
        const valueMatch = at.snippet.match(/['"]([^'"]{8,})['"]/);
        const value = valueMatch?.[1] ?? matchedText;
        if (looksLikePlaceholder(at.snippet)) continue; // drop obvious placeholders
        // Config/module path values (a/b/c) look secret-y by name but are not.
        if (/^[A-Za-z0-9_.]+(?:\/[A-Za-z0-9_.-]+)+$/.test(value)) continue;
        const entropy = shannonEntropy(value);
        if (entropy < 3.0) continue; // low-entropy → not a real secret
        confidence = entropy >= 4.0 ? "medium" : "low";
      }

      seeds.push(buildSeed(detector, item, { ...at, confidence }, path));
    }
  }

  return seeds;
}

export function scoreSeed(seed) {
  return (PRIORITY_WEIGHT[seed.priority] ?? 0.3) * (CONFIDENCE_WEIGHT[seed.confidence] ?? 0.3);
}

export function dedupeSeeds(seeds) {
  const seen = new Set();
  const out = [];
  for (const seed of seeds) {
    const key = `${seed.detectorId}::${seed.path}::${seed.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(seed);
  }
  return out;
}

export function rankSeeds(seeds) {
  return dedupeSeeds(seeds).sort((a, b) => {
    const byScore = scoreSeed(b) - scoreSeed(a);
    if (byScore !== 0) return byScore;
    const byConfidence = (CONFIDENCE_RANK[b.confidence] ?? 0) - (CONFIDENCE_RANK[a.confidence] ?? 0);
    if (byConfidence !== 0) return byConfidence;
    return a.path.localeCompare(b.path) || a.line - b.line;
  });
}

export function summarize(seeds) {
  const bySection = {};
  const byConfidence = { high: 0, medium: 0, low: 0 };
  const byPriority = { P1: 0, P2: 0, P3: 0 };
  const items = new Set();
  for (const seed of seeds) {
    bySection[seed.section] = (bySection[seed.section] ?? 0) + 1;
    byConfidence[seed.confidence] = (byConfidence[seed.confidence] ?? 0) + 1;
    byPriority[seed.priority] = (byPriority[seed.priority] ?? 0) + 1;
    items.add(seed.item);
  }
  return { total: seeds.length, bySection, byConfidence, byPriority, distinctItems: items.size };
}

// Coverage: which methodology items are automated vs. handed to the live/manual lane.
export function coverage({ methodology, detectors }) {
  const automated = new Set((detectors.detectors ?? []).map((d) => d.item));
  const items = methodology.items ?? [];
  const manual = items.filter((item) => !automated.has(item.id));
  return {
    totalItems: items.length,
    automatedItems: automated.size,
    manualItems: manual.length,
    automatedIds: [...automated].sort((a, b) => a - b),
    manual: manual.map((item) => ({ id: item.id, lane: item.lane, priority: item.priority, title: item.title })),
  };
}

// ScoutIQ scope guard — "scope is law" (methodology item 97), enforced in code.
//
// The live lane must never touch an asset you are not authorized to test. This
// module is fail-closed: it denies by default, denies unless the engagement is
// marked verifiedByUser, and ALWAYS denies loopback / RFC1918 / link-local /
// cloud-metadata addresses so the tooling can never be turned into an SSRF
// pivot. It grants nothing on its own — it only ever narrows what you may hit.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PRIVATE_V4 = [
  [0x0a000000, 0xff000000], // 10.0.0.0/8
  [0x7f000000, 0xff000000], // 127.0.0.0/8 loopback
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
  [0xac100000, 0xfff00000], // 172.16.0.0/12
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16
  [0x64400000, 0xffc00000], // 100.64.0.0/10 CGNAT
  [0x00000000, 0xff000000], // 0.0.0.0/8
];

const METADATA_HOSTS = new Set([
  "169.254.169.254", "metadata.google.internal", "metadata.goog",
  "100.100.100.200", "fd00:ec2::254",
]);

function ipv4ToInt(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value * 256 + n) >>> 0;
  }
  return value >>> 0;
}

export function isPrivateOrMetadata(host) {
  const h = String(host ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (METADATA_HOSTS.has(h)) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  // IPv6 loopback / unique-local / link-local
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:") || h === "::") return true;
  if (h.startsWith("::ffff:")) return isPrivateOrMetadata(h.slice(7)); // v4-mapped
  const asInt = ipv4ToInt(h);
  if (asInt != null) {
    return PRIVATE_V4.some(([base, mask]) => (asInt & mask) >>> 0 === (base & mask) >>> 0);
  }
  return false;
}

// Match a host against a scope rule: exact, "*.example.com" (subdomains only),
// or a leading-dot suffix ".example.com" (domain + subdomains).
export function hostMatchesRule(host, rule) {
  const h = String(host ?? "").toLowerCase().replace(/\.$/, "");
  let r = String(rule ?? "").toLowerCase().trim();
  if (!h || !r) return false;
  // Strip scheme/path/port if a full URL or host:port was pasted as a rule.
  r = r.replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");
  if (r.startsWith("*.")) {
    const base = r.slice(2);
    return h === base || h.endsWith(`.${base}`);
  }
  if (r.startsWith(".")) {
    const base = r.slice(1);
    return h === base || h.endsWith(`.${base}`);
  }
  return h === r;
}

export function parseHost(target) {
  const raw = String(target ?? "").trim();
  if (!raw) return null;
  try {
    const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withScheme).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

// The core decision. Returns { decision, reason, host, matchedRule }.
export function checkTarget(target, engagement, { allowPrivateRanges = false } = {}) {
  const host = parseHost(target);
  if (!host) return { decision: "deny", reason: "unparseable target (no host)", host: null, matchedRule: null };
  if (!engagement) return { decision: "deny", reason: "no engagement configured (fail-closed)", host, matchedRule: null };
  if (engagement.verifiedByUser !== true) {
    return { decision: "deny", reason: "engagement is not verifiedByUser — confirm scope on the official policy first (fail-closed)", host, matchedRule: null };
  }

  const allowPrivate = allowPrivateRanges || engagement.allowPrivateRanges === true;
  if (!allowPrivate && isPrivateOrMetadata(host)) {
    return { decision: "deny", reason: "private/loopback/link-local/metadata address is always blocked (SSRF safety)", host, matchedRule: null };
  }

  const outHit = (engagement.outOfScope ?? []).find((rule) => hostMatchesRule(host, rule));
  if (outHit) return { decision: "deny", reason: "matches an out-of-scope rule", host, matchedRule: outHit };

  const inHit = (engagement.inScope ?? []).find((rule) => hostMatchesRule(host, rule));
  if (inHit) return { decision: "allow", reason: "matches an in-scope rule", host, matchedRule: inHit };

  return { decision: "deny", reason: "not in the verified in-scope list (default deny)", host, matchedRule: null };
}

export function resolveEngagement(config, name) {
  const key = name ?? config.activeEngagement;
  return { key, engagement: config.engagements?.[key] ?? null };
}

export async function loadEngagementConfig(root) {
  const path = resolve(root, "config", "engagement.json");
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const argv = process.argv.slice(2);
  const targets = argv.filter((a) => !a.startsWith("--"));
  const nameFlag = argv.indexOf("--engagement");
  const name = nameFlag >= 0 ? argv[nameFlag + 1] : undefined;
  const allowPrivate = argv.includes("--allow-private");

  if (targets.length === 0) {
    console.error("usage: node scripts/scope-guard.mjs <url|host> [more...] [--engagement <name>] [--allow-private]");
    process.exitCode = 2;
    return;
  }

  const root = resolve(import.meta.dirname, "..");
  const config = await loadEngagementConfig(root);
  const { key, engagement } = resolveEngagement(config, name);

  let anyDenied = false;
  for (const target of targets) {
    const result = checkTarget(target, engagement, { allowPrivateRanges: allowPrivate });
    if (result.decision === "deny") anyDenied = true;
    const mark = result.decision === "allow" ? "ALLOW" : "DENY ";
    const rule = result.matchedRule ? `  (${result.matchedRule})` : "";
    console.log(`[${mark}] ${target}  →  ${result.reason}${rule}  [engagement: ${key}]`);
  }
  process.exitCode = anyDenied ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`scope-guard failed: ${error.message}`);
    process.exitCode = 2;
  });
}

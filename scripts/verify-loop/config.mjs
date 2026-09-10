// Configuration loading, defaults, and the clean-lane safety guard.
//
// The verify-loop is config-driven (target repo path, stack, vuln classes,
// tool paths, local-instance connection). This module resolves a config from a
// JSON file merged over built-in defaults, merges CLI overrides on top, and
// enforces the hard clean-lane boundary: the only network host the tool may
// ever touch for a *target* is a local instance the operator built.

import { resolve } from "node:path";
import { readJson } from "./io.mjs";

export const KNOWN_STACKS = Object.freeze(["solidity", "js-ts", "python", "php", "go"]);
export const HYPOTHESIZER_PROVIDERS = Object.freeze(["deterministic", "anthropic", "command"]);

export function defaultConfig() {
  return {
    version: 1,
    target: { repoPath: "", gitUrl: "", ref: "", permalinkBase: "" },
    stack: "auto",
    vulnClasses: [],
    hypothesizer: {
      provider: "deterministic",
      maxCandidates: 40,
      anthropic: {
        model: "claude-opus-5",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        baseUrl: "https://api.anthropic.com",
        maxTokens: 16_000,
        maxFilesPerBatch: 10,
      },
      command: { argv: [] },
    },
    tools: {
      slither: "",
      semgrep: "",
      codeql: "",
      forge: "",
      echidna: "",
      halmos: "",
      mythril: "",
      docker: "",
      semgrepRules: "",
      codeqlDb: "",
      customDetectorDir: "",
    },
    confirm: {
      timeoutMs: 240_000,
      requireDynamicPoc: false,
      codeqlCreateDb: false,
      runtimeHarnessScript: "",
      fuzzHarnessArgv: [],
    },
    localInstance: { baseUrl: "", containerName: "", allowNonLocalAck: false },
    templatesPath: "config/verify-templates.json",
    auditStore: "data/verify-loop.json",
    scanGlobs: [],
    maxFileBytes: 1_000_000,
    maxFiles: 4_000,
  };
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

// Deep-merge source over target for plain objects; arrays and scalars replace.
export function mergeConfig(target, source) {
  if (!isPlainObject(source)) return target;
  const output = Array.isArray(target) ? [...target] : { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(output[key])) output[key] = mergeConfig(output[key], value);
    else output[key] = value;
  }
  return output;
}

export async function loadConfig({ root, configPath, overrides = {} } = {}) {
  const base = defaultConfig();
  let fileConfig = {};
  if (configPath) {
    fileConfig = (await readJson(resolve(root, configPath), null)) ?? {};
  }
  let config = mergeConfig(base, fileConfig);
  config = mergeConfig(config, overrides);
  return config;
}

// --- Clean-lane boundary -------------------------------------------------

const LOCAL_HOSTNAMES = new Set(["localhost", "host.docker.internal"]);

function ipv4ToOctets(host) {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

// A local-instance URL must resolve to loopback, a private LAN range, an mDNS
// .local name, localhost, or the docker host alias. Anything routable on the
// public internet is rejected so the tool can never point its runtime harness
// at a live third-party target.
export function isLocalInstanceUrl(value) {
  if (!value) return false;
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  if (!/^https?:$/.test(url.protocol)) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (LOCAL_HOSTNAMES.has(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "[::1]") return true;
  if (host.startsWith("fc") || host.startsWith("fd")) return true; // IPv6 ULA fc00::/7

  const octets = ipv4ToOctets(host);
  if (octets) {
    const [a, b] = octets;
    if (a === 127) return true; // loopback 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
    if (a === 0) return true;
    return false;
  }
  return false;
}

// Validate a resolved config. Returns { ok, errors[], warnings[] }. This is the
// single enforcement point for the clean-lane rules; the orchestrator refuses to
// run when `ok` is false.
export function validateConfig(config) {
  const errors = [];
  const warnings = [];

  if (config.stack !== "auto" && !KNOWN_STACKS.includes(config.stack)) {
    errors.push(`unknown stack "${config.stack}"; expected auto or one of ${KNOWN_STACKS.join(", ")}`);
  }

  const provider = config.hypothesizer?.provider ?? "deterministic";
  if (!HYPOTHESIZER_PROVIDERS.includes(provider)) {
    errors.push(`unknown hypothesizer provider "${provider}"; expected one of ${HYPOTHESIZER_PROVIDERS.join(", ")}`);
  }
  if (provider === "command" && !(config.hypothesizer?.command?.argv?.length > 0)) {
    errors.push("hypothesizer.provider is \"command\" but hypothesizer.command.argv is empty");
  }

  const baseUrl = config.localInstance?.baseUrl ?? "";
  if (baseUrl && !isLocalInstanceUrl(baseUrl)) {
    // Hard stop: a non-local base URL would let the runtime harness reach a
    // third-party target, which the clean lane forbids. There is no ack override
    // for a public host — reachability against a live target is confirmed by the
    // human, outside this tool.
    errors.push(
      `localInstance.baseUrl "${baseUrl}" is not a local address. The runtime harness only runs against loopback/private hosts or a local container. Live third-party reachability is confirmed by the human, outside this tool.`,
    );
  }

  if (config.confirm?.runtimeHarnessScript && !baseUrl && !config.localInstance?.containerName) {
    warnings.push("confirm.runtimeHarnessScript is set but no localInstance.baseUrl/containerName is configured; the runtime-harness confirmer will be skipped.");
  }

  return { ok: errors.length === 0, errors, warnings };
}

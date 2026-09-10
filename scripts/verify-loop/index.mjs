// Public API for the verify-loop module: a hybrid LLM + program-analysis
// verification harness (LLM proposes, deterministic tools confirm) that turns
// source-evident hypotheses into tool-verified findings with local PoCs.
//
// It is a LOCAL source-analysis tool: it operates only on locally-cloned target
// code and on local instances the operator builds, and it never sends a request
// to a live third-party target. The human reviews every confirmed finding,
// confirms live reachability, and files it. Nothing is auto-filed.

export { runVerifyLoop } from "./loop.mjs";
export { loadConfig, defaultConfig, validateConfig, isLocalInstanceUrl, KNOWN_STACKS, HYPOTHESIZER_PROVIDERS } from "./config.mjs";
export { loadTemplates, templatesFor, allVulnClasses } from "./templates.mjs";
export { ingest, detectStack, stackOfFile } from "./ingest.mjs";
export { hypothesize, deterministicMatch, candidateId } from "./hypothesize.mjs";
export { ADAPTERS, buildContext, probeRegistry, routeConfirmers, confirmCandidate } from "./confirm.mjs";
export { applyGate, gateCandidates } from "./gate.mjs";
export { buildPoc, buildQ1Request, buildHttpRequest, buildFoundryPoc, payloadFor } from "./poc.mjs";
export { buildPermalink, normalizeRemote, resolveCommitContext } from "./permalink.mjs";
export { buildFinding, buildAuditEntry, persistAudit } from "./emit.mjs";

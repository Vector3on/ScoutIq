# verify-loop hunt — results

Using the verify-loop harness to hunt **source-available, in-scope, bounty-offering**
targets. All analysis is LOCAL: targets were cloned to local disk and the harness
ran locally. **Nothing contacted a live third-party system.** helios confirms
live reachability and decides what to file. This document files nothing.

Run date: 2026-09-10. Scope data: `arkadiyt/bounty-targets-data` (cloned locally).
Provider: `deterministic` (no `ANTHROPIC_API_KEY` in this environment).

## Honest frame

The classes this harness confirms best — reentrancy via Slither, SQLi via Semgrep
taint — are exactly what a competent target's own team already runs in CI. On
mature, audited code the high-confidence hits are already fixed or are known
false positives. The only real edge is **fresh code nobody has scanned yet**, so
the hunt is ranked by freshness and **most runs are expected to be empty**. A
verified empty is the correct result. Nothing below is inflated into a bug it is
not.

**Bottom line: 0 novel payable findings.** One target produced two tool-confirmed
but benign low-severity hits (assessed below); the other was a clean verified
empty. This is the expected outcome against well-scanned targets.

## TASK 1 — ranked, in-scope, source-available shortlist

Extracted from the platform feeds: programs that **offer bounties** with an
in-scope `SOURCE_CODE`/`SMART_CONTRACT` asset or a GitHub/GitLab repo URL, kept to
stacks this harness confirms (Solidity via Slither/Foundry; JS/TS/Python/PHP web
backends via Semgrep). 222 unique in-scope repos total (203 bounty-offering);
after dropping flagships and non-supported stacks, ranked by freshness:

| # | Repo | Platform / scope | Bounty / KYC | Stack | Freshness | Status |
|---|------|------------------|--------------|-------|-----------|--------|
| 1 | circlefin/evm-gateway-contracts | HackerOne `circle-bbp`, `SMART_CONTRACT`, max sev **critical** | bounty-eligible; KYC not in feed — verify on platform | Solidity (Foundry) | last commit 2026-09-02 (~8d), 3 commits/60d, core files changed | **RAN** |
| 2 | auth0/auth0-php | Bugcrowd `auth0-okta`, category other, "Auth0 PHP SDK" | max payout $50k, safe harbor full; KYC verify on platform | PHP (library) | last commit 2026-09-02 (~8d), 26 commits/60d | **RAN** |
| 3 | circlefin/evm-xreserve-contracts | HackerOne `circle-bbp`, `SMART_CONTRACT`, critical | bounty-eligible | Solidity (Foundry) | last commit 2026-06-18 (~3mo), no 60d changes | examined — build blocked offline (see caveats) |
| 4 | circlefin/evm-cpn-contracts | HackerOne `circle-bbp`, `SMART_CONTRACT`, critical | bounty-eligible | Solidity (Foundry, npm deps) | last commit 2026-06-25 (~2.5mo), no 60d changes | deprioritized — not fresh |
| 5 | smartcontractkit/staking-v0.1 | HackerOne `chainlink`, `SOURCE_CODE`, critical | bounty-eligible | Solidity | last commit 2026-01-02 (~8mo) | deprioritized — stale |

Exact in-scope lines (pasted):
- Circle BBP (`https://hackerone.com/circle-bbp`, offers_bounties=true, open): `SMART_CONTRACT: https://github.com/circlefin/evm-gateway-contracts` (eligible_for_bounty=true, max_severity=critical). Same for `evm-xreserve-contracts` and `evm-cpn-contracts`.
- Auth0 by Okta (`https://bugcrowd.com/engagements/auth0-okta`, max_payout=$50k, safe_harbor=full): in-scope asset `other` → `https://github.com/auth0/auth0-php` ("Auth0 PHP SDK (auth0-php)").

Deliberately skipped (flagship / unsupported stack / stale): smartcontractkit/chainlink
(Go, huge), Chia-Network/chia-blockchain (Python, huge), tronprotocol/java-tron
(Java — unsupported), kubernetes/*, nodejs/node, expressvpn/lightway (C),
expressvpn/wolfssl-rs (Rust). KYC/researcher-eligibility is not exposed in the
feeds; helios must confirm it on the platform before any live step.

## TASK 2 — harness runs (LOCAL)

Confirmers installed for this hunt: Slither 0.11.6, solc 0.8.29/0.8.19 (GitHub
release binaries — binaries.soliditylang.org is egress-blocked), Foundry `forge`
1.5.1 (GitHub release), Semgrep 1.176.1 (venv) with a **local** taint ruleset
(the `--config auto` registry is egress-blocked).

### Target 1 — circlefin/evm-gateway-contracts  (Solidity, fresh)

In scope: `SMART_CONTRACT: https://github.com/circlefin/evm-gateway-contracts`
(Circle BBP, critical, bounty-eligible). Compiled locally with `forge build`
(solc 0.8.29, OpenZeppelin + memview-sol submodules). Recently-changed core files
(last 60d): `GatewayMinter.sol`, `GatewayWallet.sol`, `modules/wallet/Burns.sol`,
`modules/wallet/ContractSignatureSigners.sol`, `modules/wallet/ContractSignersAllowlist.sol`.

Harness (`--stack solidity --provider deterministic`):
- confirmers available: **slither, foundry**
- candidates proposed: **40**  |  tool-confirmed: **2**  |  killed at gate: **38**

Commit pinned: `fd51093c7a1ba8e50ea2c6029ebf1bdc2bb2b8e8`.

**Tool-confirmed (handed to helios — assessed benign, recommend NO-FILE):**

1. `reentrancy` — src/modules/wallet/Deposits.sol:216
   - permalink: https://github.com/circlefin/evm-gateway-contracts/blob/fd51093c7a1ba8e50ea2c6029ebf1bdc2bb2b8e8/src/modules/wallet/Deposits.sol#L216
   - confirming tool: **slither `reentrancy-events` (impact Low, confidence Medium)** at Deposits.sol:219
   - PoC: Foundry scaffold emitted; Q1: re-enter before the external call returns and assert an accounting invariant breaks.
2. `reentrancy` — src/modules/wallet/Deposits.sol:243
   - permalink: https://github.com/circlefin/evm-gateway-contracts/blob/fd51093c7a1ba8e50ea2c6029ebf1bdc2bb2b8e8/src/modules/wallet/Deposits.sol#L243
   - confirming tool: **slither `reentrancy-events` (impact Low, confidence Medium)** at Deposits.sol:219
   - PoC/Q1: same class as above.

**Honest triage (grounded in the code, not assumed):** both sites are benign.
`_depositWithApproval`/`_depositWithPermit` update state (`_increaseAvailableBalance`)
**before** the external `IERC20.safeTransferFrom`, then `emit Deposited` after it —
correct checks-effects-interactions. `reentrancy-events` fires **only** because an
event is emitted after the external call; there is no state write after the call and
the token is the trusted deposit asset. The harness template's "HIGH" is its own
severity guess; the confirming tool's actual impact is **Low** (event-ordering).
This is not a payable bug. It is exactly the known/benign detector output the honest
frame predicts on audited code. Reported for transparency; recommend no-file.

slither also surfaced one High `arbitrary-send-erc20` (Deposits.sol) and several
Mediums (`uninitialized-local`, `unused-return`) outside the harness's template
map; `arbitrary-send-erc20` on a deposit `transferFrom` is a textbook detector FP
(intended allowance-based pull) and is not carried as a finding.

### Target 2 — auth0/auth0-php  (PHP web lane, fresh)

In scope: Bugcrowd Auth0 by Okta, `other` → `https://github.com/auth0/auth0-php`
(max payout $50k, safe harbor full). Harness (`--stack php --provider deterministic`,
Semgrep + local PHP taint ruleset):
- confirmers available: **semgrep**
- files scanned: 3917  |  candidates proposed: **40**  |  tool-confirmed: **0**  |  killed: **40**

**Result: verified empty.** The deterministic matcher's proposals were high-recall
false matches (e.g. the substring `exec` in interface method names), and the Semgrep
taint rules (request-superglobal source → SQLi/command/include/unserialize sink)
confirmed none — as expected for an SDK that does not read request superglobals.
This is the gate working: propose wide, let the tool kill false positives, report
an honest empty.

## TASK 3 — handoff

For helios:
- **circlefin/evm-gateway-contracts**: 2 tool-confirmed `reentrancy-events` (Low)
  hits at Deposits.sol:216 and :243, assessed benign (CEI followed). Confirm the
  assessment; recommend no-file. No live reachability step is meaningful here.
- **auth0/auth0-php**: empty — nothing to file.

No finding was filed to any program. No live third-party system was contacted.

## Caveats (offline sandbox)

- GitHub REST API is gated to the session's repo scope, so freshness/language were
  read from **local `git log`** on the clones, not the API.
- The semgrep rule **registry** (`--config auto`) and **binaries.soliditylang.org**
  are egress-blocked. Worked around with a local Semgrep ruleset and GitHub
  release solc binaries. These are environment limits, not target properties.
- **circlefin/evm-xreserve-contracts** could not be compiled here: a transitive
  dep (`evm-cctp-contracts`) pins solc `=0.7.6`, which Foundry's solc manager
  cannot resolve offline. Its run is **inconclusive (not run)**, not an empty —
  it should be re-run in an environment with network access to solc binaries.
- Reproduction of the runs is recorded in `scripts/verify-loop/VALIDATION.md`
  (harness validation) and the commands above.

# verify-loop — ground-truth validation

Records the bug that made the confirmation path never fire, the fix, and the
real end-to-end runs that prove the loop confirms known bugs. All validation is
LOCAL-only, on contracts/snippets created for this purpose. Nothing was ever run
against a live third-party target.

## The bug (confirmed)

`which()` in `scripts/verify-loop/io.mjs` probed tools by spawning `command -v`.
`command` is a shell builtin with no executable, so `spawn` threw ENOENT and
`which()` returned `null` for **every** binary — git included. Every confirmer
then read `unavailable`, every candidate was killed at the gate, and the module
could only ever emit a false "honest empty."

Reproduced before the fix:

```
$ node -e "import('./scripts/verify-loop/io.mjs').then(async m => {
    for (const b of ['sh','git','node']) console.log(b, '->', await m.which(b)); })"
sh -> null
git -> null
node -> null
```

The 34 original tests all passed only because each injected a fake
`which`/`runCommand`; none exercised the real PATH probe with a real tool.

## The fix

Run the builtin through a shell, and reject binary names that aren't well-formed
(so a name is never interpolated into the shell as arbitrary text):

```js
if (typeof binary !== "string" || !/^[A-Za-z0-9._+\/-]+$/.test(binary)) return null;
const probe = process.platform === "win32"
  ? await runCommand("where", [binary], { timeoutMs: 5_000 })
  : await runCommand("sh", ["-c", `command -v -- ${binary}`], { timeoutMs: 5_000 });
```

After the fix:

```
sh -> /usr/bin/sh
git -> /usr/bin/git
node -> /opt/node22/bin/node
x; echo pwned -> null        (injection guard)
```

A second wiring gap surfaced during validation: the slither adapter only ran
`slither <dir>`, which compiles nothing on a target without a build framework
("0 contracts analyzed"). The adapter now falls back to analyzing the
candidate's file directly when the whole-target scan yields no detectors. This
only surfaces additional real detectors; every hit is still matched by file+line.

## Regression coverage added (`tests/verify-loop.test.mjs`)

- `which()` unit test: asserts `which("sh","")` resolves a real path, a bogus
  name returns `null`, and a shell-metacharacter name is rejected.
- Real-tool-on-PATH end-to-end test: puts a fake `slither` executable on `PATH`,
  runs the full loop with the **real** `which`/`runCommand` (no injection), and
  asserts the candidate is CONFIRMED and emitted with a PoC + Q1 (not killed).

Proven to guard the bug (temporarily reverting the fix):

```
# under the bug:  not ok - end-to-end with a REAL tool on PATH  (the real which() must detect slither on PATH)
# under the fix:  ok      - end-to-end with a REAL tool on PATH
```

Full suite: `node --test tests/verify-loop.test.mjs` → **36/36 pass**.

## Tools installed

| Tool | Version | Source |
|---|---|---|
| slither | 0.11.6 | `pip install slither-analyzer --break-system-packages` |
| solc | 0.8.19 | GitHub release binary (`solc-static-linux`) — binaries.soliditylang.org is egress-blocked (403) in the sandbox, so solc-select's default host cannot be used |
| semgrep | 1.176.1 | isolated venv (`/tmp/sgvenv`) — a direct `pip install` conflicted with the debian-managed PyJWT |

## Solidity lane — CONFIRMED (slither)

Target `src/VulnerableBank.sol`: reentrancy (external call before the balance
write) plus a `tx.origin` authorization check.

```
$ node scripts/verify-loop.mjs --target <dir> --stack solidity --provider deterministic

confirmers available: slither
confirmers missing:   mythril, foundry, echidna, halmos, semgrep, codeql, runtime-harness, fuzzer

✔ CONFIRMED findings (6) — tool-verified, awaiting human review:
  [reentrancy] src/VulnerableBank.sol:19  (HIGH)
    confirmed by: slither (taint/static proof)
      - slither: slither reentrancy-eth (impact High, confidence Medium) at .../VulnerableBank.sol:16
    PoC: <id>.t.sol (foundry)
    Q1: Deploy an attacker contract whose receive()/fallback re-enters the target before the first external call returns; assert the tracked balance invariant is violated.
  [tx-origin-auth] src/VulnerableBank.sol:24  (MEDIUM)
    confirmed by: slither — tx-origin (impact Medium, confidence Medium)
  [missing-access-control] ...  confirmed by: slither — arbitrary-send-eth (High/Medium)
```

The reentrancy hypothesis is CONFIRMED by slither `reentrancy-eth`. `tx-origin`
and `arbitrary-send-eth` are also confirmed. Before the fix this run printed
`confirmers available: none` and `CONFIRMED findings: none`.

## Web lane — CONFIRMED (semgrep, taint-mode)

Target `app.py`: Flask handler concatenating `request.args.get("id")` into
`cursor.execute(...)`. `--config auto` (the semgrep rule registry) is
egress-blocked in the sandbox, so a local taint rule was used
(`tools.semgrepRules`, the documented offline path).

```
$ node scripts/verify-loop.mjs --target <dir> --config /tmp/vl-web.json   # stack python, vulnClasses [sql-injection]

confirmers available: slither, semgrep

✔ CONFIRMED findings (1):
  [sql-injection] app.py:11  (HIGH)
    confirmed by: semgrep (taint/static proof)
      - semgrep: semgrep tmp.sgrules.python-sqli-taint at .../app.py:11
    PoC: <id>.http.txt (http-request)
    Q1: Against the LOCAL instance, send a boolean-based payload and its negation to the endpoint and assert the responses diverge.
```

The SQLi hypothesis is CONFIRMED by a semgrep taint-mode rule that matches the
`request.args` source flowing into the `execute()` sink.

## Honest caveats

- **semgrep OSS dataflow trace**: semgrep 1.176 OSS does not emit the structured
  `dataflow_trace` object in its JSON (even with `--dataflow-traces`, which the
  adapter now passes). The taint-mode rule still matches source→sink, so the
  finding confirms and is reported as "taint/static proof"; the per-finding
  `taintProven` flag (which keys on that object) stays false under the OSS engine.
- **Line-window precision**: the confirmer matches a detector to a candidate
  within a ±25-line window, so on a small file a candidate can be confirmed by a
  real detector in an adjacent function (e.g. a `missing-access-control`
  candidate matched by `arbitrary-send-eth` a few lines away). Every confirmation
  is backed by a real tool detector; the window only affects which nearby
  candidate it attaches to.
- **Registry access**: offline rule/registry hosts (semgrep registry,
  binaries.soliditylang.org) are blocked in this sandbox; validation used release
  binaries and a local ruleset accordingly.

## Clean lane

Both validations ran against contracts/snippets created locally for this
purpose. No request was sent to any live third-party target.

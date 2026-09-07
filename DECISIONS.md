# Decisions and tradeoffs

| Choice | Reason | Cost / limitation |
| --- | --- | --- |
| New branch from the pinned master; path-copy code instead of merging branches | Preserve every existing branch and master file | Source lineage is recorded in `organism/SOURCES.json`, not as merge ancestry |
| Copy the complete Loam v4 core and policy suite | Preserve working interfaces, additive v2/v3 lineage and all gates | More inherited source is present than this slice imports |
| Keep existing UI/hosting files and workflows byte-identical | This request is for an organism, not a replacement site | No UI integration or deployment |
| New bounded supervisor, using original Loam modules directly | Enforce the smaller observe-only capability set without editing the general worker | Not registered as another general-worker domain; use `organism/cli.mjs` |
| Offline snapshots only | Strongest concrete interpretation of THINKS, does not TOUCH | No autonomous acquisition; a human supplies new public/authorized material |
| Commit IDs plus source digests | Trace every observation and invalidate changes | Git commit metadata is operator-attested; SHA-256 checks bytes, not remote authorship |
| Source redaction before extraction; no excerpts or procedures in output | Keep source content from becoming instructions or leaked sensitive values | Pattern-based sanitization is not a universal secret detector; inferred evidence addresses sanitized text |
| Use Blindsight lexical facts and import linker | Reuse actual code and evidence coordinates with zero dependencies | Regex extraction misses methods and many language constructs; no semantic parsing |
| Supplement whole-word hints with explicit camelCase-friendly cues | The original extractor missed most gate-related references in the real slice | More false-positive family hints; they are marked as unverified |
| Four static hypotheses, two family heuristics, radius 0/1 | Small enough to test every new mechanism and inspect every claim | Deliberately finite, not general security reasoning or open-ended language growth |
| Grow a lens only at an information ceiling and only over captured imports | Connect a diagnosed blind spot to a real additional observer | No import means an unresolved ceiling; no network fallback |
| Family join indexes all inherited atlas/catalog records | Preserve the shared vocabulary and source identifiers | Broad associations are not exact applicability; procedures are not emitted |
| Optional explicit `triedCells` on each manifest target | Join seam/reference cells to prior human work without executing techniques | Import from the existing operator journal is manual; the loop never marks a technique tried |
| Original EV function, modest attention modulation | Wire the actual ranking while preserving attention for information | Demo entries have EV zero; no payout prediction improvement is established |
| Exact finite-model entropy plus Loam linear-Gaussian IG | Distinguish uncertainty over observed patterns from uncertainty over observation yield | Units and coefficients are heuristic; no claim of globally optimal active inference |
| Use posterior means rather than Thompson draws | Deterministic equal-budget comparisons and repeatability | Less stochastic exploration; not a verbatim reuse of Loam's action selector |
| QD fitness is fresh information per file; cached evidence gets no model/QD credit | Avoid manufacturing learning by replaying old evidence | Fitness measures the engineered source-pattern proxy, not security value |
| Dependency-closure keys for conclusions; content keys for observations | Reopen changed beliefs while retaining still-valid evidence and lenses | Only direct imports are in the contract; transitive semantic changes need a richer observer |
| Include target metadata and catalog version in conclusion identity | A scope/reward/journal change must not reuse a stale interpretation | Conservative invalidation can repeat a human-review proposal with a new evidence key |
| Per-database single-writer lock | Prevent concurrent runs from reusing Loam node sequence numbers | Crash-left lock needs manual inspection/removal; distributed workers are not implemented |
| Freeze the partition kernel using the original Melt exporter | Demonstrate a real portable procedure used by the running loop | Python startup dominates this small workload; freezing is portability, not a speedup claim |
| Treat frozen digest as local integrity, not sandboxing | Honest trust boundary for reviewed code | Someone who can edit both receipt and source controls the executable |
| Test on the user's public repo, staged train/held-out entrypoints | Real inspectable source with clear authorization and no target traffic | Small, development-chosen data; no generalization or bounty-success claim |
| Branch-only Actions push trigger, read-only permissions | Runs on free infrastructure without changing master or committing state | No default-branch cron; CI persistence is demonstrated inside a job, not across jobs |
| Keep the original Executable Mind experiment separately runnable | Retain its independently testable baseline rather than inventing a benchmark result | New static loop adapts its principle, not its integer-list task code |

No permission gate was removed. `organism/policy.mjs` only narrows the original
Policy instance: no manifests, no credentials, no transport, and autonomous-context
approval/execution refusal. Original behavior remains tested in the inherited suite.

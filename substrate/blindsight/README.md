# Blindsight: an evidence-driven anatomy engine

Edit the root **TARGET.json**. Set `target` to a local directory/file, a public
GitHub repository URL, or one public HTTPS document. Keep `ref` separate from a
GitHub URL. Set `mode` to `replica` to also produce a source snapshot and mock.

The Blindsight reference is an engineering metaphor: many narrow reflexes leave
shared traces; those traces activate other workers. It is not a claim of
unconscious cognition, AGI, universal replication, or unprecedented research.

## Start

From the repository root, with Node 22.13+:

```bash
node substrate/bin/blindsight.mjs watch
```

Leave it running. Saving valid TARGET.json starts a run within about half a
second when idle. Edits during a run are picked up after that run finishes; the
latest saved target wins. An empty target is idle. A malformed edit is ignored
until valid. The watcher needs a running computer or cloud process.

```json
{"target":"https://github.com/Vector3on/ScoutIq","ref":"master","mode":"replica"}
```

Local file paths are resolved relative to TARGET.json. Other configuration fields
can be omitted; defaults are bounded. Relative paths for cloud runs refer to the
Actions checkout, not your laptop.

```bash
node substrate/bin/blindsight.mjs run
node substrate/bin/blindsight.mjs status
node substrate/bin/blindsight.mjs export
```

The GitHub workflow automatically runs when TARGET.json is **committed** on
`codex/blindsight-autonomous-anatomy`, `master`, or `main`. A local save is not a
GitHub event. Runner queue time applies. Workflow dispatch is also declared;
the UI button generally requires the workflow on the default branch. There is
no promise of instant cloud compute and no polling cron wasting minutes.

The workflow validates the engine and persists the SQLite database and outputs
to the separate `blindsight-data` branch. It requires repository contents-write
permission for Actions. It serializes state writers, never force-pushes, and
never merges into the source branch. For public repositories those results are
public: use cloud runs for public material. Sensitive local material belongs in
a local checkout or private repository. Outputs have ordinary Git history, so
large repeated captures grow that branch. A workflow failure is visible rather
than silently reported as success; partial/budget runs exit 2 but still save.

## What the workers actually do

| Layer | Mechanism | Limits |
|---|---|---|
| Surface | Bounded inventory, hashes, paths, captured bytes | Text only; excluded directories and binary files recorded |
| Structure | Directories, local import resolution, cycle detection | Import resolution is heuristic; aliases and dynamic imports can remain unresolved |
| Dependencies | package.json groups, import statements, manifest lines | Non-JSON manifests are lexical, not complete package resolution |
| Contracts | OpenAPI JSON methods/responses and route declarations | Code routes are candidates; not all frameworks or mount prefixes are supported |
| Data | Recursive JSON shape, SQL table declaration candidates | JSON capped at 1,500 nodes, depth 12, 100 children per node; no semantic schema guarantee |
| Implementation | Named declarations in common source languages | Lexical extraction, not a complete parser/typechecker |
| Operations | Scripts, environment variable names, container/CI declarations | Never executes scripts, installations, or target code |
| Seams | Boundary-related lexical evidence | Candidates, not verified trust boundaries or vulnerabilities |
| Semantics | Optional model interpretations with exact source quotes | Inferred only; valid citations do not prove a conclusion |

Each artifact fans out into suitable workers. Dependency observations activate
linking; the resulting graph activates cycle analysis. Attention weights
unresolved references and boundary candidates to select scarce model calls.
The SQLite queue deduplicates tasks, leases work atomically, and retains pending
work. Restarting after a task/time budget resumes the same source snapshot.
Interrupted leases expire after 60 seconds. Failed tasks remain visible; change
`refresh` to a new value to deliberately create a fresh run and retry them.

Stop reasons are explicit: `quiescent` (current worker frontier exhausted),
`budget` (work remains), `partial` (omissions/worker failures), `empty`, or `idle`.
Quiescence is a plateau of these extractors on captured material, not knowledge
of everything. Repeat runs still acquire source to detect edits, but unchanged
artifacts reuse completed extraction tasks. There is no claim of a distributed
swarm: this version schedules small workers in one process; SQLite leases are
ready for multiple claimants, but multiple CLI runs use a process lock.

## Database and outputs

Default database: `substrate/.loam/blindsight.db`, compatible with Loam's
existing events table. The engine adds only `bs_*` tables/views. It does not
alter bounty scoring, migrate an existing remote database, or publish the site.

- `bs_runs`: status and coverage of each captured snapshot.
- `bs_artifacts`: sanitized source, metadata and content identity.
- `bs_facts`: entity, layer, predicate, typed JSON value, status, evidence, worker.
- `bs_tasks`: queue state, priority, attempts, lease and error.
- `bs_fields`: dynamically discovered field names and value types.
- `bs_entity_attributes`: observed attributes grouped into JSON arrays per entity.

New concepts become new typed attributes automatically. This avoids unsafe
dynamic SQL and column-count ceilings while preserving many values per field.
All queries use bound parameters for values.

```sql
SELECT layer,predicate,type FROM bs_fields ORDER BY layer,predicate;
SELECT entity,attributes FROM bs_entity_attributes WHERE run_id = ?;
SELECT entity,predicate,value,evidence FROM bs_facts
WHERE run_id = ? AND layer = 'contracts';
SELECT state,COUNT(*) FROM bs_tasks WHERE run_id = ? GROUP BY state;
```

Outputs live in `substrate/out/blindsight/<run-id>/`:

- `REPORT.md`, `coverage.json`: what was seen, skipped, failed and not verified.
- `anatomy.json`, `facts.jsonl`, `attributes.json`: reusable data and evidence.
- `graph.json`, `contracts.json`: structural relationships and captured routes.
- `model-tasks.jsonl`: bounded source-analysis tasks for a separate model session.
- `replica/` in replica mode: sanitized source subset, manifest and mock server.

All evidence refers to the **sanitized stored artifact**, not a guaranteed line
number in the original file. Known token formats, credential assignments and
common PII are redacted; .env files, keys, symlinks, binaries, generated files and
dependency folders are excluded. Pattern redaction is not a proof of complete
secret removal. A redacted snapshot intentionally differs from source.

The mock is runnable with `node mock.mjs` from replica/. It binds to loopback and
returns 501 for captured contracts, 404 otherwise. It does not reproduce backend
logic or claim behavioral equivalence. The source snapshot is never installed
or executed automatically. LICENSE files from the captured subset are retained.

## Model integration without mandatory API spending

Default mode makes **zero LLM calls**. Deterministic extraction is autonomous,
but it is not an LLM intelligence service. Existing ChatGPT/Claude consumer
subscriptions are not wired into this process as unattended API credentials.

For an available OpenAI-compatible local server, set in TARGET.json:

```json
{"llm":{"enabled":true,"endpoint":"http://127.0.0.1:11434/v1/chat/completions","model":"YOUR_INSTALLED_MODEL","maxCalls":4}}
```

A remote endpoint must use HTTPS; enabling one sends bounded sanitized source
to that provider and may cost money. Put credentials only in environment variable
`BLINDSIGHT_LLM_TOKEN`. Inference is opt-in, limited to maxCalls per snapshot/model,
uses a timeout and response byte cap, and rejects output without exact evidence.
Source instructions cannot enqueue commands, fetch targets, modify policy, or
execute code. All model facts remain `inferred`.

Alternatively, take a task from `model-tasks.jsonl` into your existing model
session and save its result as one JSON object per line:

```json
{"artifact":"EXACT_ARTIFACT_ID","facts":[{"entity":"handler","layer":"semantics","predicate":"responsibility","value":"Interpretation","start":1,"end":2,"quote":"exact source substring"}]}
```

```bash
node substrate/bin/blindsight.mjs import --run RUN_ID --input results.jsonl
```

The importer validates artifact ownership, span bounds, schema and quotes. This
manual bridge is not unattended inference.

If `LOAM_DB_URL` and `LOAM_DB_TOKEN` are already configured, CLI runs push the
sanitized fact events through Loam's existing Turso sync. The remote hub receives
events, **not** the `bs_*` projection tables or source text. The local SQLite
database/data branch retains the full anatomy. No Turso account is provisioned.

## Verification

```bash
node --test substrate/tests/blindsight.test.mjs
cd substrate
npm test
```

Tests exercise complete capture-to-replica runs, snapshot idempotency, database
reopening/resume, expired leases, symlink/secret handling, pinned GitHub reads,
network stop signals, model-grounding rejection, automatic model scheduling,
deep graph traversal, and file-save activation. Network/model fixtures validate
protocol behavior; they do not certify any live provider's availability.

Implementation references: [Node's built-in SQLite API](https://nodejs.org/api/sqlite.html),
[GitHub workflow triggers](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).

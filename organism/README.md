# Synthesis organism

One offline loop: source anatomy, catalog family joins, competing static hypotheses,
information-directed attention, bounded lens mutation, Loam event memory and QD,
and a Melt-frozen partition kernel. Read [the design](../DESIGN.md) and
[decisions](../DECISIONS.md) before interpreting results.

## Run

Node 24 and Python 3.8+; standard libraries only, no npm install, model, key, GPU,
or target connection. From the repository root:

```bash
node organism/cli.mjs
node organism/cli.mjs
```

The first command writes `organism/out/report.json` and
`organism/state/memory.db`. The second replays the same evidence without duplicate
proposals. Keep the database between runs. Run one writer at a time.

Reproduce the documented baseline, adaptive, repeat and held-out comparisons:

```bash
node organism/demo.mjs organism/out/demo
node --test organism/tests/*.test.mjs
node --test --test-concurrency=1 substrate/tests/*.test.mjs
```

The checked-in results are in [examples/results/REPORT.md](examples/results/REPORT.md).
The demo observes the repository's own real public source, pinned to an exact
revision. It does not invent a paying bounty program for the demonstration.

## Supply another local snapshot

Copy `organism/examples/snapshot.json` and review the explicit file list and targets.
Each file must have an exact source revision and SHA-256. Paths resolve relative to
the manifest. Only already-acquired public/authorized source belongs here. The
manifest is an operator attestation, not proof a program grants testing permission.
No file is installed, imported as code, built or executed. Symlinks, traversal,
binary files, mismatched digests and excess byte budgets are refused.

Each target supplies an entrypoint, a `program` and `asset` in ScoutIq's normalized
EV schema, and a `purpose` of `research` or `bounty`. Existing normalized public
program metadata can be copied into those fields. The organism does not fetch a
feed or acquire missing source. `offersBounties: false` and `maxReward: 0` are the
honest settings for self-observation.

```bash
node organism/cli.mjs --manifest /path/to/snapshot.json --state /path/to/memory.db --out /path/to/report.json --budget 32
```

The budget counts fresh file observations by the selected symbol readers. Snapshot
validation and the cheap lexical/import index read the bounded snapshot up front.
It is not a total disk-I/O budget. Missing captured imports remain unknown.

## Free infrastructure and persistence

The dedicated Actions workflow runs on pushes to **only** the synthesis branch and
publishes report artifacts with read-only repository permissions. It never pushes
state or touches another branch. The CI demo deliberately uses fresh state and
measures persistence within its staged runs. Cross-job durable state is not wired.

GitHub schedules run from the default branch. Adding a cron entry here would not
activate a schedule while `master` must remain untouched, so none is advertised.
For an existing free Linux runner with this checkout and Node/Python installed,
an ordinary cron entry can call the CLI using the same database:

```cron
17 */3 * * * cd /path/to/ScoutIq && node organism/cli.mjs >> organism/state/cron.log 2>&1
```

In Colab, use a runtime with Node 24 and Python, open this branch, and run the same
commands in shell cells. Put `--state` on your mounted persistent storage. Colab
runtime setup and a live Colab execution have not been tested in this change; the
verified free-infrastructure route is the dedicated GitHub Actions job.

## Frozen kernel

```bash
python3 organism/freeze.py
```

This uses the original Melt exporter and interpreter, plus the small reviewed
`organism/capsules/partition.py`. `organism/frozen/partition.py` runs by itself on
JSON stdin. The main loop checks its receipt digest before execution. The receipt
provides integrity relative to the checkout, not a trust anchor against someone
who can edit both script and receipt. Only this fixed reviewed executable is run;
snapshot contents never become programs.

## What the words mean

- **Distinguished**: one of four lexical source-pattern hypotheses remains.
- **Information ceiling**: captured observations cannot distinguish survivors.
- **Lens transfer**: a previously useful family/radius grammar is used on another entrypoint.
- **Fresh observation bits**: reduction within that finite prediction model from uncached questions.
- **Technique reference**: coarse catalog family membership, with applicability unverified.

No result certifies a boundary, runtime behavior, defect, severity, or bounty eligibility.
The only proposal is human review of captured evidence. There is no approval or
execution entrypoint in this organism.

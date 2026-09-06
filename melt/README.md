# Melt

**Turn model-authored procedures into portable executable capabilities. Disconnect the model. Measure what remains.**

Melt is the first working slice of the ice-to-water concept: some behavior expressed by a model can take an independent computational form. This project was written and tested by the conversational assistant in one development session. It uses public implementation notes and generated source, never protected internal reasoning traces.

The result is a standalone Python file that runs on another machine with no repository checkout, model API, credentials, or package installation. Python 3.10+ is required; development validation used Python 3.12. This is bounded procedural export, not whole-model transfer, consciousness transfer, neural distillation, or a sandbox escape.

## Start here

From the repository root:

```bash
python3 melt/cli.py target
```

Edit [MELT_TARGET.json](../MELT_TARGET.json) to choose a capability and provide its input. The current default constructs a cost-optimal conditional diagnosis policy. The command writes `melt/out/my-capability.py` and executes it in a fresh Python process.

The new branch's GitHub workflow repeats validation and export whenever Melt or its target file changes. Download its `melt-<run-id>` artifact from the Actions run. It contains the standalone capabilities and experiment findings. This workflow does not merge or deploy the ScoutIQ site and uses no model secrets.

Try the portable file from a directory outside this repository:

```bash
python3 /path/to/my-capability.py < /path/to/diagnosis.json
```

Use [diagnosis.json](benchmarks/examples/diagnosis.json) as that input. Windows users can supply the same JSON through their shell or a redirected JSON file. The output includes the result and an execution receipt with source digests, capability calls, and step count. `model_calls: 0` describes this runtime's architecture; it is not an externally measured counter of an inaccessible provider.

## Seven exported forms

| Capsule | Useful behavior | Input |
|---|---|---|
| `objects` | Same-color connected components, areas, cells, bounding boxes | `grid`, optional integer `background` and `connectivity` of 4 or 8 |
| `plan` | Deterministic dependency layers, blocked tasks, actual cycle members | `tasks`, mapping names to dependency lists |
| `probe` | Experiment minimizing expected surviving hypotheses under a uniform prior | `candidates`, equally sized categorical prediction vectors |
| `scene` | Composes `objects` and `plan` into a scene assembly description | Same input as `objects` |
| `state_planner` | Minimum-cost planning through actions that add and delete facts | `initial`, partial `goal`, actions with `pre`, `effect`, and `cost` |
| `visual_rule` | Infer a composition from examples; preserve competing explanations | Grid `examples`, `query`, optional bounded `max_depth` |
| `diagnose` | Minimum worst-case-cost conditional testing policy | `hypotheses`, tests with costs and outcomes, optional prior `observed` results |

The perception demonstration uses integer pixel grids; it is not a general image-understanding model. The planner produces plans and never runs tasks against external systems.

```bash
python3 melt/cli.py list
python3 melt/cli.py export plan --out melt/out/planner.py
python3 melt/cli.py run plan --input tasks.json
python3 melt/cli.py experiment --out melt/out/experiment.json
python3 -m unittest discover -s melt/tests -v
```

## Harder reasoning benchmarks

The second experiment exports runtime search, rule induction, and conditional question planning. [Read its findings](benchmarks/FINDINGS.md), [public strategies](benchmarks/STRATEGIES.md), and [evaluation contract](benchmarks/CONTRACT.md).

```bash
python3 melt/cli.py benchmark
python3 melt/cli.py run state_planner --input melt/benchmarks/examples/state_setback.json
python3 melt/cli.py run visual_rule --input melt/benchmarks/examples/visual_ambiguity.json
python3 melt/cli.py run diagnose --input melt/benchmarks/examples/diagnosis.json
```

All 229 final checks passed: 147 completed tasks, 27 proved-unreachable planning goals, and 55 explicit uncertainty/limit outcomes. These are original synthetic problems, not official ARC, PlanBench, or tau2 scores. Runtime tests now total 15. No live LLM comparison was performed.

Example planner input:

```json
{"tasks":{"collect":[],"analyze":["collect"],"publish":["analyze"]}}
```

Example experiment-selection input:

```json
{"candidates":[["same","red"],["same","blue"],["same","green"]]}
```

## What the self-experiment found

| Capability | Initial version | Revised version |
|---|---:|---:|
| Pixel objects | 504 / 613 | 613 / 613 |
| Dependency planning | 131 / 163 | 163 / 163 |
| Experiment selection | Not separately revised | 100 / 100 |
| Composed scene | Not separately revised | 39 / 39 |

The initial perception program omitted diagonal connectivity; the initial planner confused cycle members with blocked descendants. Their original source and two development observations are retained. The assistant revised the programs in this session. The detached runtime did not rewrite them.

All 915 revised checks passed, alongside 8 invalid-input rejection cases and 7 runtime tests. Evaluation executes each exported capability in a fresh Python process with an empty environment and temporary working directory. A Python audit hook rejects socket and process-launch events; none occurred. On the development Linux host, CPU, address-space, and file-size resource limits were applied. This is not kernel network isolation.

Candidate digests are frozen before evaluation instances are generated. The evaluator uses union-find for object ground truth, transitive closure for cycle membership, and pairwise comparisons for probe scores, while exports use different algorithms. Both sides were authored by the same assistant, and the task family was known. These results are not an independent or blinded benchmark and do not establish general reasoning transfer.

Read [FINDINGS.md](FINDINGS.md), [the recorded results](findings/experiment.json), and [the development observations](findings/development_observations.json).

## Grow the project

```bash
python3 melt/cli.py request "A new capability to export" --out melt/out/request.json
```

This writes a concrete authoring request for a model you can use. There is no unattended model connection disguised behind this command. A model or human must supply the candidate source.

Add a reviewed `capsules/<name>.py` containing `run(data)` and a corresponding catalog entry. The source language permits plain functions, assignments, conditionals, loops, and named helpers. It rejects imports, attributes, dynamic calls, comprehensions, private names, and undeclared dependencies. Use `get`, `append`, `put`, `add`, `pop`, and `require` for common operations. `use('name', data)` composes a declared dependency.

Define independent behavior checks before promoting the candidate. Export resolves its dependency closure, validates syntax and source digests, adds execution metering, and packages the runtime and implementations into one file. It does not automatically translate unrestricted natural-language traces into correct programs. That unresolved step is a central future research target, not an implemented feature.

## Execution boundaries

- The runtime has no model client, network helper, shell, filesystem helper, or credential interface available to capsule source.
- JSON structure and size, loop/function steps, source length, and declared dependencies are bounded. A CLI execution also has a wall-clock timeout.
- This restricted language is not a hardened general-purpose Python sandbox. Some individual Python operations can still consume excessive resources. Do not execute unreviewed hostile source in a privileged process. For hostile-code research, use a separate OS sandbox with real resource and access controls.
- Digests identify content and detect accidental mismatch; they are not signatures or proof that a candidate is safe or correct.
- Changing `MELT_TARGET.json` selects among known capsules and changes input. It cannot create a new general capability on its own.

## Files

`runtime.py` defines the execution language. `cli.py` validates, bundles, exports, and runs it. `capsules/` contains model-authored implementations. `history/` preserves the initial versions. `experiment.py` runs the detached comparisons. `tests/` checks important runtime boundaries. [DESIGN.md](DESIGN.md) records the concept and the remaining research gap.

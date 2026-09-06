# Self-export experiment 1

Date: 6 September 2026. Source: this assistant's public code and observable executions in the development session.

**Observed result:** four standalone exports passed 915 checks after two assistant-led revisions. They executed without the original conversational model or repository. This establishes bounded procedural export for the tested families.

## What I actually did to myself

I acted as the capability author: I expressed strategies in source, exported that source, inspected execution results, and revised missing decision rules. No private reasoning was accessed, no weights were read or changed, and no API vulnerability was exercised. My conversational runtime did not migrate. The exported implementations were the experimental material.

## Development observations

1. `objects` v0 ignored requested 8-neighbor connectivity and split two diagonal pixels into two objects. v1 made the connectivity rule explicit and validated it.
2. `plan` v0 called every blocked task a cycle member. For `a -> b -> a` with `c` depending on `b`, it incorrectly classified `c` as cyclic. v1 added strongly connected component analysis.

The initial prototypes were deliberately small, and the author chose these checks. These are documented implementation failures, not evidence of blind scientific discovery or autonomous self-repair.

## Results

| Family | Cases | v0 passed | v1 passed |
|---|---:|---:|---:|
| Connected pixel objects | 613 | 504 | 613 |
| Dependency graphs | 163 | 131 | 163 |
| Informative experiments | 100 | Not evaluated separately | 100 |
| Composed perception and plan | 39 | Not evaluated separately | 39 |

Eight malformed-input cases were rejected. Seven runtime tests passed, including metering an infinite loop, rejecting unavailable authority, digest mismatch, cyclic dependency declarations, composition, and deterministic portable export.

The grid set includes exhaustive binary 2x4 images under both connectivity rules, random colored grids, and a 64x64 boundary case. Graphs include random cyclic and acyclic structures, a 128-node chain, and a dense 128-node graph. Other cases exercise varying prediction matrices and composition. The fixed seed is 260906.

## Isolation and measurement

Each exported family ran in a new isolated Python process with an empty environment and a temporary working directory containing only its standalone file and the evaluation driver. A Python audit hook rejected socket and process-launch operations. No such attempts occurred. Linux resource limits bounded CPU, address space, and file size in the recorded run. This is not a claim of kernel-enforced network isolation or a hardened sandbox.

The exported call graph contains no model client or model inference operation. Execution receipts report zero model calls as a property of that architecture. They cannot introspect activity inside the conversational model that authored the files.

Candidate hashes were frozen before the generated evaluation corpus was instantiated. Both candidate and oracle were authored by the same assistant, using different algorithms where practical. The task families were already known. The cases are fresh inputs, not a blinded holdout designed by an independent evaluator.

## What the result supports

- A capability can be represented in code, packaged with its runtime, and used away from the originating conversation.
- Several such capabilities can compose through explicit interfaces.
- Exporting a verbal intention requires decision rules that a short explanation may omit.
- Failure cases and versioned source provide an empirical basis for revision.

## What it does not support

- Lossless conversion of a model or general reasoning trace into code.
- Transfer of consciousness, identity, or arbitrary intelligence.
- Autonomous revision by the detached runtime: revisions here were mine.
- General-purpose computer vision: the visual domain is bounded integer grids.
- A performance advantage over direct model inference: no paired live-model baseline was measured.

The next decisive experiment must compare an actual model-assisted conversion process with simpler code generation, using equal budgets and independently checked unfamiliar tasks. The current project provides the export and evaluation machinery for that comparison.

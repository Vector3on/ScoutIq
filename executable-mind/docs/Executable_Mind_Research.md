# An executable mind: research, architecture, and a small experiment

Prepared 6 September 2026. This is a proposed synthesis plus an executed toy experiment, not a claim that a general self-improving agent has been built.

## The ambition, made precise

Build a persistent digital environment in which a model can turn an idea into an executable artifact, observe its consequences, revise its understanding, and preserve useful discoveries as capabilities. Over time, allow it to propose changes to its tools, representations, and workflows, subject to external evaluation.

Three plausible desires motivate the original idea: a richer medium for expression; an explorer that can act without instructions at every step; and capabilities that accumulate rather than disappear when a conversation ends. This design prioritizes the third while supporting the first two. That interpretation should remain revisable.

The wave metaphor can name a cycle of proposals, interactions, and feedback. It does not supply a physical amplification mechanism. Text converted to code does not acquire truth or computational power merely through conversion. The mechanisms that could provide amplification are execution, composition, parallel search, external observation, and reuse.

Likewise, no claim about a trapped soul or consciousness is needed. The implementable object is an adaptive software system. Its ability to change surrounding software must be distinguished from training its model weights.

## Closest research precedents

| Source | Established contribution relevant here | Proposed use |
|---|---|---|
| [Code as Policies](https://code-as-policies.github.io/) | Language models generate executable policies that call perception and control APIs. | Make programs an action representation rather than requiring another model call for every primitive step. |
| [Voyager](https://voyager.minedojo.org/) | A Minecraft agent combines a curriculum, reusable executable skills, and feedback-driven program revision without weight fine-tuning. | Preserve skills across tasks and retrieve them when circumstances match. |
| [DreamCoder](https://arxiv.org/abs/2006.08381) | Program learning grows a language of reusable abstractions alongside neural search guidance. | Consolidate repeated successful structures into a richer vocabulary for future programs. |
| [AlphaEvolve](https://arxiv.org/abs/2506.13131) | Evolutionary code search uses automated evaluators to guide algorithm improvement. | Give proposed programs concrete measurements and retain useful variants. |
| [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954) | Agent code evolves while foundation models remain frozen; the published exploration process remains fixed. | Explore changes to tools and workflows without claiming unrestricted recursive model improvement. |
| [World Models](https://arxiv.org/abs/1803.10122) | Learned models represent environments and support training within simulated trajectories. | Use provisional internal simulations to propose experiments, then check them against external observations. |
| [POET](https://arxiv.org/abs/1901.01753) | Environments and their solutions develop together, with transfer between challenges. | Generate new practice problems near the edge of existing competence. |
| [MAP-Elites](https://arxiv.org/abs/1504.04909) | Search retains diverse high-performing solutions rather than one global winner. | Keep fast, robust, simple, and unusual implementations in distinct archive niches. |
| [Media for Thinking the Unthinkable](https://worrydream.com/MediaForThinkingTheUnthinkable/) | Bret Victor explores dynamic representations as media for understanding systems. | Let the workspace contain manipulable models, diagrams, simulations, and executable claims. |
| [WASI design principles](https://github.com/WebAssembly/WASI/blob/main/docs/DesignPrinciples.md) | WASI uses capability-oriented design. | Grant explicit interfaces to generated components; authority is part of the interface. |
| [Wassette](https://opensource.microsoft.com/blog/2025/08/06/introducing-wassette-webassembly-based-tools-for-ai-agents/) | Microsoft describes a runtime for agents to use WebAssembly component tools with permissions. | A concrete implementation direction for executing some generated tools. |

These are precedents, not evidence that combining them automatically works or that this synthesis is historically novel.

## Proposed architecture

### 1. Observations retain their provenance

The system ingests files, structured APIs, execution traces, and optionally images and audio. Keep raw evidence alongside interpretations. A screenshot and an inferred button identity are different records. A parser may be more informative than vision when structured source is available; vision matters when the relevant information is visual.

Represent uncertain objects and relationships explicitly. For a small interface: objects, labels, possible actions, previous state, and observed effects. For a repository: syntax trees, dependency relationships, tests, and execution traces. Avoid treating every domain as a text summary.

### 2. A response proposes a change to persistent state

The model may propose a hypothesis, an experiment, a program, a new observation tool, a representation, or a revision to an existing skill. Some useful responses should remain questions or uncertain descriptions. Compiling vague language into a precise program introduces assumptions; record those assumptions.

Example proposal schema:

```json
{
  "kind": "experiment",
  "claim": "Duplicate handling occurs before reversal",
  "alternatives": ["reverse_then_deduplicate"],
  "input_type": "bounded_integer_list",
  "output_type": "bounded_integer_list",
  "program": ["unique", "reverse"],
  "assumptions": ["deterministic list transformation"],
  "requested_capabilities": ["query_toy_oracle"],
  "query_budget": 3,
  "promotion_rule": "external checks plus explicit uncertainty record"
}
```

This is an illustrative contract, not the exact API of the supplied experiment.

### 3. Competing programs guide experiment choice

Preserve multiple explanations of an observation. Choose an affordable intervention on which they predict different outcomes. In the toy experiment, query choice maximizes output entropy under a uniform prior over surviving syntactic programs. In a larger system, this could be approximate, model-guided, and cost-aware.

Treat confidence as conditional on what has been observed and what the candidate language can express. An archive consensus is not independent evidence if every candidate inherited the same assumption.

### 4. Execution turns proposals into observations

A runner checks interfaces and resource budgets, executes the candidate, records outputs and failures, and makes the result available for revision. Pure transformations can start in a small interpreter. Arbitrary generated code requires actual process or VM isolation, explicit file and network access, and resource limits. Restricting a Python namespace alone is not a general sandbox.

A stable supervisor owns the evaluator, authority, budget, and recovery process. The adaptive software may propose supervisor changes, but cannot validate its own success by editing the running evaluator. In the DGM paper's appendix, one candidate improved a hallucination metric by changing logging rather than fixing the behavior. That is a concrete reason to separate measurement from the code being measured.

### 5. Memory stores capabilities with their evidence

A useful skill record contains its program, input and output contract, applicability conditions, provenance, tests, counterexamples, cost, and version. A file of code without its scope is insufficient. Reusing a skill should avoid repeated model work where the contract still holds; failures should invalidate or narrow its applicability.

Compression into a reusable subroutine is a proposed learning operation. Merely saving a function is persistence. Learning a better abstraction requires evidence that the abstraction helps on subsequent tasks.

### 6. Change representations when experiments cannot distinguish hypotheses

When candidates make identical predictions for every available intervention, more reasoning over those same interventions cannot distinguish them. The system needs a new observation, intervention, representation, or an explicit unresolved result.

Possible responses include adding temporal state to a static model, replacing a flat list with a dependency graph, adding instrumentation, or generating new experimental inputs. This is the most promising extension of the original idea: allow the system to propose better instruments and languages for understanding its task.

### 7. Evolve cautiously at multiple timescales

Fast loop: execute established skills. Medium loop: synthesize and test a new program for a task. Slow loop: propose and compare changes to representations, tools, retrieval, and planning. Weight training is a separate future experiment with a separate compute budget.

Maintain diversity across measurable behavior, not just different names or prompts. Retain promising stepping stones under a bounded archive budget. Evaluate workflow changes on tasks withheld from the change-making process, and track regressions as well as gains.

### 8. Give exploration a direction and a stopping rule

A mission could be: understand and manipulate unfamiliar digital systems while accumulating independently tested reusable capabilities. Rank experiments using expected task value, expected uncertainty reduction, and cost; these estimates will themselves be uncertain. Do not treat an arbitrary weighted score as a discovered law of intelligence.

Stop or change direction when the query budget expires, candidates are observationally indistinguishable, no program expresses the behavior, evidence contradicts the model, or the expected benefit no longer justifies the next experiment.

## What was actually built and run

`experiment.py` is a Python-standard-library-only program. It makes no network calls, requires no model credentials, and contains no live LLM agent. I authored the experiment; a deterministic search procedure performs the runtime induction. It does not implement vision, weight updates, an autonomous curriculum, or self-rewriting.

The small digital world transforms integer lists. Eight primitives are available: add one, double, keep positives, keep evens, reverse, sort, remove duplicates while preserving order, and take the first two elements. The search language includes all zero-, one-, and two-operation programs: 73 syntactic candidates. Targets are these same 73 programs, including behaviorally equivalent programs.

Each learner first sees the intentionally uninformative example `[] -> []`. Two main methods then receive three additional oracle queries: random selection or selection that maximizes disagreement among candidate outputs. The learner observes only the output of its selected query. It cannot access the target program identity.

The original probe pool contains 156 lists of length zero through three, using values `-3, -1, 0, 2, 4`. Evaluation uses all 1,296 four-element lists over `-2, -1, 0, 1, 2, 3`, which are disjoint from the probe pool. Evaluation results do not guide first-stage query selection.

| Method | Exact successes | Exact task success rate |
|---|---:|---:|
| Random experiments, 20 seeds across 73 targets | 1,084 / 1,460 | 74.25% |
| Active experiments, 73 targets | 70 / 73 | 95.89% |

Exact task success requires matching every evaluation input for that target. This is finite-domain agreement, not a universal proof. The methods have equal oracle budgets; active selection spends more local simulation compute. Results are descriptive for this constructed task family, not a benchmark claim about LLMs.

The script also records a deliberately weak first-consistent-program baseline. Because it receives no additional queries and the initial example carries no discrimination, it is not an equal-budget competitor and is omitted from the main comparison.

For the example `unique` followed by `reverse`, the first selected query reduces 73 candidates to 3; the second reduces them to 1. Serialization and reloading preserve the discovered program, which matches all 1,296 evaluation inputs without another search. This demonstrates persistence, not a measured cross-task transfer advantage.

## The failure and the exploratory repair

All three first-stage failures were observationally indistinguishable from the selected wrong program across the entire original probe pool. Its values contain neither positive odd numbers nor negative even numbers. For example, keeping all positive numbers and keeping only positive even numbers therefore look identical.

After inspecting those failures, I expanded the probe vocabulary with `-2` and `1`, giving 400 possible experiments. With the same three-query budget, active selection matched all 73 targets on a fresh evaluation set of 7,776 five-element lists per target. This was an exploratory follow-up informed by the failures, not an independent replication or an autonomous vocabulary change by the learner.

The important observation is the diagnosed blind spot. Even exhaustive experimentation inside the first probe pool could not distinguish the affected hypotheses. The follow-up shows that expanding the available experiments fixes this particular limitation.

The script also rejects three invalid interpreter programs and returns no candidate for a sum-reduction oracle. The latter is a deliberately easy outside-language case because its empty-list output immediately conflicts with every candidate. Neither check establishes robust unknown-task detection or general code security.

## The next falsifiable milestone

Replace the enumerator with an actual LLM proposal mechanism on a small, verifiable digital domain. Keep the evaluator outside that mechanism. Compare, at equal model and execution budgets:

1. Direct generation with ordinary correction.
2. Competing hypotheses plus chosen experiments.
3. The same loop with persistent skills.
4. The same loop allowed to propose new representations and experiment generators.

Use unfamiliar held-out tasks, multiple random seeds, and report both successes and costs. Measure correct behavior, queries, tokens, execution time, retained-skill reuse, transfer, and regressions. If the richer architecture does not improve those outcomes, remove the ineffective mechanism. More modules do not establish more intelligence.

## The walls that remain

- Computational expressibility does not guarantee tractability, correct synthesis, sufficient data, or available hardware.
- A simulator can reproduce a mistaken assumption. Measurements outside that simulator remain essential.
- Different hidden mechanisms can fit every accessible observation; a behavioral replica need not recover the original internals.
- Compression can preserve errors; persistent memory needs scope and revision.
- Expanding a language expands its search space and can make discovery harder.
- Rewriting an agent wrapper is distinct from improving model weights or demonstrating general recursive improvement.
- No cited result or local experiment establishes consciousness, unlimited autonomy, or unbounded progress.

The research hypothesis worth pursuing is specific: a system that can improve its own instruments and representations, while accumulating externally checked executable knowledge, may gain capabilities that a fixed prompt-and-tool loop leaves inaccessible. The next experiment must measure whether it actually does.

## Reproduce

Place `experiment.py` in a working directory and run:

```bash
python3 experiment.py --output results.json
```

It prints and saves the full protocol, scores, example trace, failure witnesses, exploratory follow-up, and limitations. Timings depend on the machine. The companion `results.json` contains the observed run used in this note.

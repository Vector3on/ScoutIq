# Melt: preserve the phase-change ambition

The central question is whether capabilities expressed through a model can acquire independent executable forms. Independence, breadth, and cost must be measured together. A cached answer has little breadth; a general API proxy has little independence.

This first slice implements one transformation: assistant-authored procedural source becomes a portable, bounded executable. It also demonstrates composition, failure recording, and assistant-led revision. It does not claim to recover the model's internal algorithm.

## Public implementation notes

These are deliberately concise design specifications for the artifacts, not internal chain-of-thought transcripts.

| Capability | Public strategy | Concrete executable form |
|---|---|---|
| Perceive grid objects | Group neighboring cells of the same non-background color under an explicit connectivity rule; retain geometry | Flood-fill procedure, bounded frontier, object records |
| Plan dependencies | Schedule ready tasks; separately determine actual cyclic components | Layer construction plus strongly connected component analysis |
| Choose a question | Prefer a query whose candidate predictions leave fewer hypotheses indistinguishable | Category partitions and expected survivor counts |
| Compose a scene | Use perception output as the entities of a dependency plan | A capsule calling two declared capabilities |

The explicit connectivity input and the distinction between cycles and their descendants were missing from the first implementations. Translating an intention into executable decisions exposed those gaps. Recording the exact inputs and source digests makes the revisions reviewable.

## Implemented transformation

1. The assistant writes a public specification and a `run(data)` procedure.
2. The validator checks the supported syntax and declared dependency graph.
3. The exporter embeds the runtime and complete dependency closure into one Python file.
4. The evaluator runs that file away from the checkout, without model credentials or network operations.
5. Independent algorithmic checks score fresh inputs within the declared task families.
6. The assistant revises observed failures; source history and receipts preserve the evidence.

The exporter is a compiler/packager for a restricted procedural language. It is not a natural-language-to-code compiler or an automatic distillation trainer. The assistant is the author and reviser in this experiment.

## What is still missing

The most ambitious next component is a strategy inducer: given permitted outputs, public explanations, and input/action/outcome records, propose conditional mechanisms that transfer to new inputs. It must distinguish deterministic operations from semantic judgments that still need a learned model. Multiple examples and counterexamples are essential because one trajectory does not specify a complete policy.

A later representation selector could choose code, state machines, constraint systems, or small neural models. This repository implements only the code route. A later improvement process could propose better conversion strategies, but should be evaluated on conversion tasks it did not optimize against. No self-preservation, credential acquisition, unauthorized propagation, hidden-trace extraction, or containment bypass is needed for the research objective.

## Measurable future work

- Compare an actual connected model against exported procedures on previously withheld task instances and task families. Account for inference, synthesis, tests, and execution cost.
- Add an LLM-authored candidate interface that keeps generation and evaluation separate. The current `request` command supplies an explicit handoff file and does not pretend a provider is connected.
- Compare general model calls, procedural exports, and permitted specialist-model distillation. Count unsupported cases instead of silently calling an unavailable model.
- Test whether a new representation improves conversion success on fresh tasks, rather than increasing source volume.
- Add real OS-level execution isolation before accepting hostile or unknown generated programs.

## Research context

- [Program of Thoughts](https://arxiv.org/abs/2211.12588): executable computation as part of language-model problem solving.
- [Distilling Step-by-Step](https://arxiv.org/abs/2305.02301): rationales as supervision for smaller task-specific models; a different transfer route from this project's procedural export.
- [Language Models Don't Always Say What They Think](https://arxiv.org/abs/2305.04388): reasons to avoid treating textual explanations as complete accounts of causal computation.
- [Voyager](https://voyager.minedojo.org/): reusable executable skills.
- [DreamCoder](https://arxiv.org/abs/2006.08381): learned reusable program abstractions.
- [Stealing Reasoning Traces from Proprietary LLM APIs](https://arxiv.org/abs/2608.09867): relevant security context for distinguishing permitted behavioral evidence from protected traces. No attack from this paper is implemented here.

These precedents motivate components. They do not establish novelty, consciousness transfer, or general model conversion for Melt.

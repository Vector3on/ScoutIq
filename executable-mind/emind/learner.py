"""The inductive learner: propose, experiment, observe, revise.

This is the loop that ties the components together. Given a hidden target oracle
and a query budget, it:

1. sees one free, deliberately uninformative example ``[] -> oracle([])``;
2. repeatedly chooses an experiment (random or active), queries the oracle,
   and restricts the hypothesis archive to the surviving candidates; then
3. returns the first surviving candidate as its learned program -- or reports
   "no candidate" when the oracle lies outside the language.

The learner never sees the target's identity, only the outputs of its own
chosen queries.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Callable, List, Optional, Sequence

from . import world
from .hypotheses import HypothesisArchive

Oracle = Callable[[Sequence[int]], Sequence[int]]


@dataclass
class QueryStep:
    probe: world.IntList
    output: world.IntList
    entropy: float
    survivors_before: int
    survivors_after: int

    def as_dict(self) -> dict:
        return {
            "probe": list(self.probe),
            "output": list(self.output),
            "entropy_bits": round(self.entropy, 4),
            "survivors_before": self.survivors_before,
            "survivors_after": self.survivors_after,
        }


@dataclass
class LearnResult:
    strategy: str
    initial_example: dict
    steps: List[QueryStep] = field(default_factory=list)
    learned_program: Optional[world.Program] = None
    survivors_final: int = 0
    queries_used: int = 0
    no_candidate: bool = False
    stuck: bool = False

    def as_dict(self) -> dict:
        return {
            "strategy": self.strategy,
            "initial_example": self.initial_example,
            "steps": [s.as_dict() for s in self.steps],
            "learned_program": (
                list(self.learned_program)
                if self.learned_program is not None
                else None
            ),
            "learned_program_label": (
                world.program_repr(self.learned_program)
                if self.learned_program is not None
                else None
            ),
            "survivors_final": self.survivors_final,
            "queries_used": self.queries_used,
            "no_candidate": self.no_candidate,
            "stuck": self.stuck,
        }


class InductiveLearner:
    """Runs one induction episode against a hidden oracle."""

    def __init__(
        self,
        probe_pool: Sequence[world.IntList],
        candidates: Optional[Sequence[world.Program]] = None,
    ) -> None:
        # Candidates from the enumerator are valid by construction, so the
        # archive runs them through the pure interpreter directly. The
        # validating ``execution.Runner`` guards the *proposal boundary* --
        # the place an untrusted proposer (e.g. a future model) would plug in.
        self.probe_pool = list(probe_pool)
        self._candidates = candidates

    def run(
        self,
        oracle: Oracle,
        strategy: str = "active",
        budget: int = 3,
        rng: Optional[random.Random] = None,
    ) -> LearnResult:
        if strategy == "random" and rng is None:
            raise ValueError("random strategy requires an rng")

        archive = HypothesisArchive(self._candidates)

        # 1. The free, usually-uninformative example.
        empty_out = tuple(oracle(()))
        archive.restrict((), empty_out)
        result = LearnResult(
            strategy=strategy,
            initial_example={"inputs": [], "output": list(empty_out)},
            survivors_final=len(archive),
        )
        if len(archive) == 0:
            result.no_candidate = True
            return result

        # 2. Spend the query budget choosing experiments.
        for _ in range(budget):
            if strategy == "active":
                choice = archive.select_active_probe(self.probe_pool)
            elif strategy == "random":
                choice = archive.select_random_probe(self.probe_pool, rng)
            else:
                raise ValueError(f"unknown strategy {strategy!r}")
            if choice is None:
                break

            # The oracle is the external world: its answer is an observation,
            # not something the learner can simulate its way around.
            output = tuple(oracle(choice.probe))
            before = len(archive)
            after = archive.restrict(choice.probe, output)
            result.steps.append(
                QueryStep(
                    probe=choice.probe,
                    output=output,
                    entropy=choice.entropy,
                    survivors_before=before,
                    survivors_after=after,
                )
            )
            result.queries_used += 1
            if after == 0:
                result.no_candidate = True
                break

        # 3. Commit to the first surviving candidate.
        result.survivors_final = len(archive)
        result.stuck = archive.is_stuck(self.probe_pool)
        result.learned_program = archive.pick()
        result.no_candidate = result.learned_program is None
        return result


def oracle_from_program(program: Sequence[str]) -> Oracle:
    """Build an oracle that applies a fixed in-language program."""
    prog = tuple(program)

    def _oracle(inputs: Sequence[int]) -> List[int]:
        return world.run_program(prog, inputs)

    return _oracle


def behaviorally_equal(
    program: Sequence[str],
    oracle: Oracle,
    eval_inputs: Sequence[world.IntList],
) -> bool:
    """True if ``program`` matches ``oracle`` on every evaluation input."""
    for x in eval_inputs:
        if world.run_program(program, x) != list(oracle(x)):
            return False
    return True

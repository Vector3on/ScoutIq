"""Competing hypotheses and experiment choice (architecture sections 3 & 6).

We keep *every* program consistent with what we have observed, rather than
committing early to one explanation. To learn efficiently we then choose an
affordable experiment (a probe input) on which the surviving hypotheses
disagree the most -- the query that maximizes the entropy of predicted outputs
under a uniform prior over surviving programs.

Section 6 is handled by :meth:`HypothesisArchive.is_stuck`: when no available
probe separates the survivors, more reasoning over the same probes cannot help,
and the system must widen its instruments (a new probe vocabulary) or record an
unresolved result.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

from . import world


@dataclass
class ProbeChoice:
    """A chosen experiment and why it was chosen."""

    probe: world.IntList
    entropy: float
    survivors_before: int


class HypothesisArchive:
    """The set of programs still consistent with every observation so far."""

    def __init__(self, candidates: Optional[Sequence[world.Program]] = None) -> None:
        if candidates is None:
            candidates = world.enumerate_programs()
        # Preserve canonical order so "first surviving candidate" is stable.
        self.candidates: List[world.Program] = list(candidates)

    def __len__(self) -> int:
        return len(self.candidates)

    def restrict(self, inputs: world.IntList, output: world.IntList) -> int:
        """Keep only candidates that reproduce ``output`` on ``inputs``.

        Returns the number of survivors.
        """
        target = tuple(output)
        self.candidates = [
            prog
            for prog in self.candidates
            if world.run_program(prog, inputs) == list(target)
        ]
        return len(self.candidates)

    def output_distribution(
        self, probe: world.IntList
    ) -> Dict[world.IntList, int]:
        """Map each distinct output on ``probe`` to how many survivors produce it."""
        counts: Dict[world.IntList, int] = {}
        for prog in self.candidates:
            out = tuple(world.run_program(prog, probe))
            counts[out] = counts.get(out, 0) + 1
        return counts

    def entropy(self, probe: world.IntList) -> float:
        """Shannon entropy (bits) of survivor outputs on ``probe``."""
        counts = self.output_distribution(probe)
        n = len(self.candidates)
        if n == 0:
            return 0.0
        ent = 0.0
        for c in counts.values():
            p = c / n
            ent -= p * math.log2(p)
        return ent

    def select_active_probe(
        self, probe_pool: Sequence[world.IntList]
    ) -> Optional[ProbeChoice]:
        """Choose the probe that maximizes disagreement among survivors.

        Ties are broken by earliest position in ``probe_pool`` so the choice is
        deterministic.
        """
        if not self.candidates:
            return None
        best: Optional[ProbeChoice] = None
        for probe in probe_pool:
            ent = self.entropy(probe)
            if best is None or ent > best.entropy:
                best = ProbeChoice(
                    probe=probe, entropy=ent, survivors_before=len(self.candidates)
                )
        return best

    def select_random_probe(
        self, probe_pool: Sequence[world.IntList], rng: random.Random
    ) -> Optional[ProbeChoice]:
        """Choose a probe uniformly at random (the control condition)."""
        if not self.candidates:
            return None
        probe = rng.choice(list(probe_pool))
        return ProbeChoice(
            probe=probe,
            entropy=self.entropy(probe),
            survivors_before=len(self.candidates),
        )

    def is_stuck(self, probe_pool: Sequence[world.IntList]) -> bool:
        """True if no probe in the pool separates any surviving hypotheses.

        This is the section-6 signal: the archive holds more than one behavior,
        yet every available experiment predicts the same output for all of them.
        Reasoning harder over the same probes cannot break the tie.
        """
        if len(self.candidates) <= 1:
            return False
        for probe in probe_pool:
            if len(self.output_distribution(probe)) > 1:
                return False
        return True

    def pick(self) -> Optional[world.Program]:
        """Return the first surviving candidate in canonical order, if any."""
        return self.candidates[0] if self.candidates else None

    def behavioral_classes(self) -> List[List[world.Program]]:
        """Group survivors by identical behavior over a small fingerprint set.

        Used only for reporting how ambiguous the remaining set is.
        """
        fingerprint_inputs = world.make_list_pool([-2, -1, 0, 1, 2, 3], 3)
        buckets: Dict[Tuple[world.IntList, ...], List[world.Program]] = {}
        for prog in self.candidates:
            key = tuple(
                tuple(world.run_program(prog, x)) for x in fingerprint_inputs
            )
            buckets.setdefault(key, []).append(prog)
        return list(buckets.values())

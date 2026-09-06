"""Memory: store capabilities with their evidence (architecture section 5).

A useful skill record is more than a saved function. It carries the program, its
input/output contract, the conditions under which it is known to apply, its
provenance, tests it has passed, counterexamples that narrow it, a cost estimate,
and a version. Reusing a skill should avoid repeated search where the contract
still holds; a failure should narrow or invalidate its applicability.

The note is careful to distinguish *persistence* (saving a function) from
*learning* (evidence that an abstraction helps later). This module only claims
the former; it provides the substrate on which the latter could be measured.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional, Sequence

from . import world


@dataclass
class SkillRecord:
    """A learned, reusable capability plus the evidence that justifies it."""

    name: str
    program: List[str]
    input_type: str = "bounded_integer_list"
    output_type: str = "bounded_integer_list"
    applicability: str = "finite integer lists over the evaluated domain"
    provenance: str = ""
    tests: List[Dict] = field(default_factory=list)
    counterexamples: List[Dict] = field(default_factory=list)
    cost_queries: int = 0
    version: int = 1
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    def apply(self, inputs: Sequence[int]) -> List[int]:
        """Run the stored program without any further search."""
        return world.run_program(self.program, inputs)

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "program": list(self.program),
            "input_type": self.input_type,
            "output_type": self.output_type,
            "applicability": self.applicability,
            "provenance": self.provenance,
            "tests": self.tests,
            "counterexamples": self.counterexamples,
            "cost_queries": self.cost_queries,
            "version": self.version,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "SkillRecord":
        return cls(
            name=data["name"],
            program=list(data["program"]),
            input_type=data.get("input_type", "bounded_integer_list"),
            output_type=data.get("output_type", "bounded_integer_list"),
            applicability=data.get("applicability", ""),
            provenance=data.get("provenance", ""),
            tests=data.get("tests", []),
            counterexamples=data.get("counterexamples", []),
            cost_queries=data.get("cost_queries", 0),
            version=data.get("version", 1),
            created_at=data.get("created_at", ""),
        )


class SkillStore:
    """A small, serializable library of skill records keyed by name."""

    def __init__(self) -> None:
        self._skills: Dict[str, SkillRecord] = {}

    def __len__(self) -> int:
        return len(self._skills)

    def __contains__(self, name: str) -> bool:
        return name in self._skills

    def add(self, skill: SkillRecord) -> None:
        self._skills[skill.name] = skill

    def get(self, name: str) -> Optional[SkillRecord]:
        return self._skills.get(name)

    def all(self) -> List[SkillRecord]:
        return list(self._skills.values())

    def record_counterexample(
        self, name: str, inputs: Sequence[int], expected: Sequence[int]
    ) -> None:
        """Narrow a skill's applicability when it fails on a new observation."""
        skill = self._skills[name]
        skill.counterexamples.append(
            {"inputs": list(inputs), "expected": list(expected)}
        )
        skill.version += 1

    def to_json(self) -> str:
        return json.dumps(
            {name: s.as_dict() for name, s in self._skills.items()},
            indent=2,
            sort_keys=True,
        )

    def save(self, path: str) -> None:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(self.to_json())

    @classmethod
    def from_json(cls, text: str) -> "SkillStore":
        store = cls()
        for _, data in json.loads(text).items():
            store.add(SkillRecord.from_dict(data))
        return store

    @classmethod
    def load(cls, path: str) -> "SkillStore":
        with open(path, "r", encoding="utf-8") as fh:
            return cls.from_json(fh.read())

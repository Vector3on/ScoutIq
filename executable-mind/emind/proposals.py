"""Proposals: a response is a change to persistent state (architecture section 2).

A proposal is the unit the model (here: the deterministic enumerator) puts
forward -- a hypothesis, an experiment to run, a program, a new observation
tool, or a revision to an existing skill. This module gives that idea a concrete,
serializable shape matching the schema sketched in the research note.

Compiling vague language into a precise program introduces assumptions, so the
schema records those assumptions explicitly rather than hiding them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class Proposal:
    """An illustrative contract for a proposed change to persistent state."""

    kind: str  # "experiment", "hypothesis", "program", "tool", "skill_revision"
    claim: str
    program: List[str] = field(default_factory=list)
    alternatives: List[str] = field(default_factory=list)
    input_type: str = "bounded_integer_list"
    output_type: str = "bounded_integer_list"
    assumptions: List[str] = field(default_factory=list)
    requested_capabilities: List[str] = field(default_factory=list)
    query_budget: int = 3
    promotion_rule: str = "external checks plus explicit uncertainty record"
    notes: Optional[str] = None

    def as_dict(self) -> dict:
        return {
            "kind": self.kind,
            "claim": self.claim,
            "program": list(self.program),
            "alternatives": list(self.alternatives),
            "input_type": self.input_type,
            "output_type": self.output_type,
            "assumptions": list(self.assumptions),
            "requested_capabilities": list(self.requested_capabilities),
            "query_budget": self.query_budget,
            "promotion_rule": self.promotion_rule,
            "notes": self.notes,
        }

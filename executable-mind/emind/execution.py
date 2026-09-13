"""Execution: turn a proposed program into an observation, safely.

Architecture section 4 of the research note: *a runner checks interfaces and
resource budgets, executes the candidate, records outputs and failures, and
makes the result available for revision.*

For the interpreter language this is a small, honest sandbox: we validate that a
program is well-typed against the world's interface and stays within a length
budget before executing it. The note is explicit that this is **not** a general
sandbox for arbitrary code -- restricting an interpreter's vocabulary is only
safe because the vocabulary is fixed and pure. Running arbitrary generated code
would require real process/VM isolation, which is called out as future work.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Sequence

from . import world


@dataclass
class ExecutionResult:
    """Outcome of validating and (if valid) executing one program."""

    ok: bool
    program: Optional[world.Program]
    inputs: Optional[world.IntList]
    output: Optional[world.IntList] = None
    error: Optional[str] = None

    def as_dict(self) -> dict:
        return {
            "ok": self.ok,
            "program": list(self.program) if self.program is not None else None,
            "inputs": list(self.inputs) if self.inputs is not None else None,
            "output": list(self.output) if self.output is not None else None,
            "error": self.error,
        }


class Runner:
    """A stable executor for interpreter-language programs.

    The runner is owned by the supervisor, not by the adaptive part of the
    system: the learner may *propose* programs, but only the runner decides
    whether they are admissible and what they produce.
    """

    def __init__(self, max_length: int = world.MAX_PROGRAM_LENGTH) -> None:
        self.max_length = max_length
        self.executions = 0
        self.rejections = 0

    def validate(self, program: object) -> Optional[str]:
        """Return ``None`` if ``program`` is admissible, else a reason string."""
        if not isinstance(program, (list, tuple)):
            return f"program must be a sequence of primitive names, got {type(program).__name__}"
        if len(program) > self.max_length:
            return (
                f"program length {len(program)} exceeds budget "
                f"{self.max_length}"
            )
        for op in program:
            if not isinstance(op, str):
                return f"operation must be a string, got {op!r}"
            if op not in world.PRIMITIVES:
                return f"unknown primitive {op!r}"
        return None

    def execute(
        self, program: object, inputs: Sequence[int]
    ) -> ExecutionResult:
        """Validate then run ``program`` on ``inputs``."""
        reason = self.validate(program)
        if reason is not None:
            self.rejections += 1
            return ExecutionResult(
                ok=False,
                program=tuple(program) if isinstance(program, (list, tuple)) else None,
                inputs=tuple(inputs),
                error=reason,
            )
        self.executions += 1
        output = tuple(world.run_program(program, inputs))
        return ExecutionResult(
            ok=True,
            program=tuple(program),
            inputs=tuple(inputs),
            output=output,
        )


@dataclass
class RejectionReport:
    """Record of the runner refusing a batch of malformed programs."""

    checked: List[dict] = field(default_factory=list)

    def add(self, result: ExecutionResult) -> None:
        self.checked.append(result.as_dict())

    @property
    def rejected(self) -> int:
        return sum(1 for c in self.checked if not c["ok"])


def demo_invalid_programs(runner: Runner) -> RejectionReport:
    """Feed the runner three malformed programs and confirm each is rejected.

    These exercise three distinct failure modes of the interface check:

    1. an unknown primitive name,
    2. a non-string element, and
    3. a program that exceeds the length budget.
    """
    report = RejectionReport()
    invalid = [
        ["reverse", "spin"],          # unknown primitive
        ["add_one", 5],               # non-string operation
        ["sort", "reverse", "unique"],  # exceeds MAX_PROGRAM_LENGTH
    ]
    for program in invalid:
        report.add(runner.execute(program, (1, 2, 3)))
    return report

"""The small digital world: a language of integer-list transformations.

This module defines the "toy universe" the executable mind reasons about. It is
deliberately tiny and fully deterministic so that every claim the system makes
can be checked against ground truth.

Design notes (see ``executable-mind/README.md`` for the mapping to the research
note):

* Eight primitives transform a list of integers into a list of integers.
* A *program* is a tuple of 0, 1 or 2 primitive names, applied left to right.
* The complete search language is therefore every 0-, 1- and 2-operation
  program: ``1 + 8 + 8*8 = 73`` syntactic candidates.

Nothing here calls a network, a model, or anything outside the standard
library.
"""

from __future__ import annotations

from functools import lru_cache
from itertools import product
from typing import Callable, Dict, Iterable, List, Sequence, Tuple

# A concrete integer list flowing through the world.
IntList = Tuple[int, ...]
# A program is an ordered tuple of primitive names.
Program = Tuple[str, ...]


def _unique(xs: Sequence[int]) -> List[int]:
    """Remove duplicates while preserving first-seen order."""
    seen = set()
    out: List[int] = []
    for x in xs:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


# The eight primitives. Names are stable identifiers used everywhere else
# (proposals, skills, serialization), so treat them as part of the world's API.
PRIMITIVES: Dict[str, Callable[[Sequence[int]], List[int]]] = {
    "add_one": lambda xs: [x + 1 for x in xs],
    "double": lambda xs: [x * 2 for x in xs],
    "keep_positive": lambda xs: [x for x in xs if x > 0],
    "keep_even": lambda xs: [x for x in xs if x % 2 == 0],
    "reverse": lambda xs: list(xs)[::-1],
    "sort": lambda xs: sorted(xs),
    "unique": _unique,
    "take_two": lambda xs: list(xs)[:2],
}

# A fixed canonical ordering of the primitives. Program enumeration and the
# learner's "pick the first surviving candidate" rule both depend on this being
# deterministic.
PRIMITIVE_ORDER: Tuple[str, ...] = (
    "add_one",
    "double",
    "keep_positive",
    "keep_even",
    "reverse",
    "sort",
    "unique",
    "take_two",
)

# Human-readable descriptions, purely for reporting / skill provenance.
PRIMITIVE_DOC: Dict[str, str] = {
    "add_one": "add one to every element",
    "double": "double every element",
    "keep_positive": "keep strictly positive elements",
    "keep_even": "keep even elements",
    "reverse": "reverse the list",
    "sort": "sort ascending",
    "unique": "remove duplicates, preserving first-seen order",
    "take_two": "take the first two elements",
}

MAX_PROGRAM_LENGTH = 2


@lru_cache(maxsize=None)
def _run_cached(program: Program, inputs: IntList) -> IntList:
    """Execute ``program`` on ``inputs`` (memoized on hashable arguments)."""
    xs: List[int] = list(inputs)
    for op in program:
        xs = PRIMITIVES[op](xs)
    return tuple(xs)


def run_program(program: Iterable[str], inputs: Sequence[int]) -> List[int]:
    """Apply ``program`` (a sequence of primitive names) to ``inputs``.

    Raises ``KeyError`` if a primitive name is unknown; the execution runner in
    :mod:`emind.execution` validates programs before they reach here.
    """
    return list(_run_cached(tuple(program), tuple(inputs)))


def enumerate_programs(max_length: int = MAX_PROGRAM_LENGTH) -> List[Program]:
    """Return every program up to ``max_length`` ops, in canonical order.

    Order: the empty (identity) program, then all 1-op programs in
    ``PRIMITIVE_ORDER``, then all 2-op programs in lexicographic order over that
    same ordering. With the default bound this yields the 73 candidates the
    research note describes.
    """
    programs: List[Program] = [()]
    for length in range(1, max_length + 1):
        for combo in product(PRIMITIVE_ORDER, repeat=length):
            programs.append(tuple(combo))
    return programs


def program_repr(program: Iterable[str]) -> str:
    """Readable label for a program, e.g. ``identity`` or ``unique |> reverse``."""
    ops = list(program)
    if not ops:
        return "identity"
    return " |> ".join(ops)


def make_list_pool(values: Sequence[int], max_length: int) -> List[IntList]:
    """All integer lists of length ``0..max_length`` drawn from ``values``."""
    pool: List[IntList] = []
    for length in range(0, max_length + 1):
        for combo in product(values, repeat=length):
            pool.append(tuple(combo))
    return pool


def make_fixed_length_pool(values: Sequence[int], length: int) -> List[IntList]:
    """All integer lists of exactly ``length`` drawn from ``values``."""
    return [tuple(combo) for combo in product(values, repeat=length)]


# --- Oracles outside the language -------------------------------------------
#
# These are targets the search language cannot express. They exist to show that
# the system can *report ignorance* instead of confidently returning a wrong
# program.

def sum_reduction_oracle(inputs: Sequence[int]) -> List[int]:
    """Return ``[sum(inputs)]`` -- a reduction the list language cannot express.

    Crucially, on the empty list this returns ``[0]`` while every program in the
    language returns ``[]``. That single disagreement is enough to empty the
    candidate set, so the learner correctly returns "no candidate".
    """
    return [sum(inputs)]

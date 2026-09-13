"""emind -- a small, executable realization of the "executable mind" design.

The package is organised around the architecture in the research note:

* :mod:`emind.world`       -- the digital world (primitives, programs, pools)
* :mod:`emind.proposals`   -- proposals as changes to persistent state
* :mod:`emind.hypotheses`  -- competing hypotheses and active experiment choice
* :mod:`emind.execution`   -- the runner that checks interfaces and budgets
* :mod:`emind.memory`      -- skills stored with their evidence
* :mod:`emind.learner`     -- the propose/experiment/observe/revise loop

Everything is standard-library Python and fully deterministic. There is no
model call, no network, and no self-rewriting anywhere in this package.
"""

from . import execution, hypotheses, learner, memory, proposals, world

__all__ = ["execution", "hypotheses", "learner", "memory", "proposals", "world"]
__version__ = "0.1.0"

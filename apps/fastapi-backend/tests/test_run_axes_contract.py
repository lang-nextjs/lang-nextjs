"""The run-axes contract, driven against THIS plane's real implementation.

check-run-axes-parity holds the two Python planes byte-identical, which is the
right test for two copies of one source and cannot reach the TypeScript port.
So the node plane stood outside it, and what stood in for a comparison was a set
of literals in runAxes.test.ts described as "taken from the Python" -- a second
spelling with nothing asserting it still matched the first.

THE CASES COME FROM scripts/fixtures/run-axes-cases.json, not from this file,
and apps/node-backend/src/common/runAxes.test.ts reads the same file. That is
what makes this a comparison rather than two assertions: a case added here is
added to every plane at once, and a plane that drifts fails on the case rather
than on someone noticing.

IT FOUND A REAL DISAGREEMENT ON ITS FIRST RUN -- see `session-only`.
"""

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ai_backends._common import langfuse_trace_metadata, set_run_axes  # noqa: E402

FIXTURE = json.loads((ROOT / "scripts/fixtures/run-axes-cases.json").read_text())
CASES = FIXTURE["cases"]
MUST_CONTAIN = FIXTURE["mustContain"]


def test_the_contract_has_cases_and_still_has_the_ones_that_matter():
    """A table-driven test over an empty table passes, and so does one whose
    awkward cases were quietly dropped.

    BOTH HALVES ARE HERE ON PURPOSE. Non-emptiness alone is satisfied by six
    easy cases after someone deletes the hard one; naming the ids alone is
    satisfied by nothing if the list itself is empty. runAxes.test.ts had no
    session-only case at all, which is exactly how the divergence survived.
    """
    assert CASES, "the run-axes contract has no cases — it asserts nothing"
    ids = {c["id"] for c in CASES}
    missing = [i for i in MUST_CONTAIN if i not in ids]
    assert not missing, (
        f"the fixture no longer contains {missing}. These are declared in its "
        f"own mustContain list because they are the cases that found or pin a "
        f"real divergence; losing one silently is how it comes back."
    )


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_trace_metadata_matches_the_shared_contract(case):
    set_run_axes(**case["axes"])
    assert langfuse_trace_metadata() == case["expect"], case["why"]

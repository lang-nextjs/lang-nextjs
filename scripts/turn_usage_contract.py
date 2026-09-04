"""ONE READER FOR THE TURN-USAGE CORPUS, DRIVEN BY BOTH PYTHON PLANES (#727).

The corpus is scripts/fixtures/turn-usage-cases.json and the node plane reads the
same file. This module is the Python half of reading it: the cases, the
must-contain guard, and the one question the planes answer differently enough to
be worth naming once — WHERE on the finish frame a plane put the number.

Shared rather than copied for the reason scripts/sse_frame_conformance.py gives:
a copied fixture cannot be its own witness, and writing the reader twice
reintroduces the drift inside the check meant to catch it.
"""

from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURE_PATH = REPO_ROOT / "scripts" / "fixtures" / "turn-usage-cases.json"


def load_cases():
    """The corpus, or a hard failure.

    An unreadable fixture is not "no cases to run" — a parametrised test over an
    empty list passes, silently, having asserted nothing.
    """
    if not FIXTURE_PATH.exists():
        raise AssertionError(
            f"{FIXTURE_PATH} does not exist. Refusing to report a usage "
            f"contract against a corpus that could not be read."
        )
    fixture = json.loads(FIXTURE_PATH.read_text())
    cases = fixture.get("cases") or []
    if not cases:
        raise AssertionError("the turn-usage contract declares no cases")
    return fixture, cases


def missing_required_ids(fixture, cases):
    """Which of the fixture's own `mustContain` ids have gone missing.

    Non-emptiness alone is satisfied by the easy cases surviving after someone
    deletes the awkward one; naming ids alone is satisfied by nothing when the
    list is empty. Both halves, for the reason test_run_axes_contract.py gives.
    """
    ids = {c["id"] for c in cases}
    return [i for i in fixture.get("mustContain", []) if i not in ids]


def reported_usage(frames):
    """What the finish frame says the turn cost, or None if it claims nothing.

    TWO LOCATIONS ARE ACCEPTED, AND THAT IS TRANSITIONAL, NOT A DESIGN. #714
    moves usage from a top-level `totalUsage` to `messageMetadata.totalUsage`,
    because AI SDK v6 parses `finish` with `z.strictObject()` and REJECTS the
    turn outright over the extra key. That change and this corpus are deliberately
    independent — this file is about the VALUE a plane reports, and the wire
    location is guarded by finish-frame-conformance.test.ts and
    sse_frame_conformance.py, which is where a wrong location must go red.

    WHEN #714 HAS LANDED ON EVERY PLANE, DELETE THE TOP-LEVEL BRANCH. Left as-is
    it would keep accepting the shape that discards the turn, and an accepted
    shape is one that comes back.
    """
    finish = next((f for f in frames if f.get("type") == "finish"), None)
    if finish is None:
        raise AssertionError(
            "the stream carried no `finish` frame, so there is no report to read "
            "— that is a broken probe, not a turn that cost nothing"
        )
    metadata = finish.get("messageMetadata") or {}
    return metadata.get("totalUsage") or finish.get("totalUsage")

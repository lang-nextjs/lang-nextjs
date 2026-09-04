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

    ONE LOCATION, AND THE SECOND ONE HAS BEEN DELETED ON SCHEDULE. This function
    briefly accepted a top-level `totalUsage` as well, because #714 was moving
    usage to `messageMetadata.totalUsage` and had not landed on every plane. The
    note said "when #714 has landed on every plane, delete the top-level branch",
    and it has: both python emitters on main carry `messageMetadata`, and the
    node emitter never carried anything else.

    Deleted rather than left, because an accepted shape is one that comes back —
    and the shape in question is the one AI SDK v6 REJECTS outright, discarding
    the whole turn. A reader that still accepted it would go green on a frame the
    client throws away. The wire location itself is guarded by
    finish-frame-conformance.test.ts and sse_frame_conformance.py; this file is
    about the VALUE, which is why the two could move independently at all.
    """
    finish = next((f for f in frames if f.get("type") == "finish"), None)
    if finish is None:
        raise AssertionError(
            "the stream carried no `finish` frame, so there is no report to read "
            "— that is a broken probe, not a turn that cost nothing"
        )
    return (finish.get("messageMetadata") or {}).get("totalUsage")

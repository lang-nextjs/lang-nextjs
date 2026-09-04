"""The turn-usage contract, driven against THIS plane's real emitter (#727).

THE CASES COME FROM scripts/fixtures/turn-usage-cases.json, not from this file,
and apps/django-backend and apps/node-backend read the same file. That is what
makes this a comparison rather than three independent assertions: a case added
there is added to every plane at once, and a plane that drifts fails on the case
rather than on someone noticing.

WHY THIS EXISTS. #300 gave per-turn usage to the two Python planes in the same
shape and gave each its own expectations. The node plane got neither — zero
occurrences of `usage` or `token` in its emitter — so on that runtime every layer
above the model said a turn cost nothing, which is the misreport #232 opened.
check-run-axes-parity could not have seen it: it holds the two Python planes
byte-identical and correctly excludes node, because "identical" has no meaning
across languages. A shared corpus is the mechanism this repo already had for
three-plane agreement (run-axes-cases.json), and it had never been pointed here.

This file is the POSITIVE CONTROL for that corpus as much as a test of this
plane: node's red is only attributable to node if the same cases go green here
and on django in the same run.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))

deepagents = pytest.importorskip(
    "deepagents_backend.ai_backends.deepagents",
    reason="rung 3 (deepagents) is not in this tree; its emitter is what this file drives",
)

from turn_usage_contract import (  # noqa: E402
    load_cases,
    missing_required_ids,
    reported_usage,
)

FIXTURE, CASES = load_cases()


class _Chunk:
    """An AIMessageChunk as this code path actually uses it."""

    def __init__(self, usage=None):
        self.content = "x"
        self.content_blocks = [{"type": "text", "text": "x"}]
        self.tool_calls = []
        self.tool_call_chunks = []
        self.usage_metadata = usage


class _Graph:
    def __init__(self, chunks):
        self._chunks = chunks

    def astream(self, *_args, **_kwargs):
        chunks = self._chunks

        async def gen():
            for c in chunks:
                yield ((), "messages", (c, {}))

        return gen()


def _frames(chunks):
    import asyncio

    async def drain():
        out = []
        async for piece in deepagents._emit_ai_sdk_v6(
            _Graph([_Chunk(u) for u in chunks]),
            [{"role": "user", "content": "hi"}],
        ):
            out.append(piece)
        return "".join(out)

    raw = asyncio.run(drain())
    frames = []
    for line in raw.split("\n"):
        line = line.strip()
        if line.startswith("data:") and line[5:].strip() not in ("", "[DONE]"):
            frames.append(json.loads(line[5:].strip()))
    return frames


def test_the_contract_has_cases_and_still_has_the_ones_that_matter():
    """A table-driven test over an empty table passes, and so does one whose
    awkward cases were quietly dropped."""
    assert CASES, "the turn-usage contract has no cases — it asserts nothing"
    missing = missing_required_ids(FIXTURE, CASES)
    assert not missing, (
        f"the fixture no longer contains {missing}. These are declared in its own "
        f"mustContain list because each pins a DIFFERENT failure; losing one "
        f"silently is how it comes back."
    )


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_the_turn_reports_what_the_shared_contract_says(case):
    usage = reported_usage(_frames(case["chunks"]))
    if case["expect"]["reported"]:
        assert usage == case["expect"]["totalUsage"], case["why"]
    else:
        assert usage is None, case["why"]

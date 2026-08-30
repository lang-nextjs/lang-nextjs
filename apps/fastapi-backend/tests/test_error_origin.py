"""Whose failure it was, separated from what the code says (#400).

`E2E — open-swe live transport` failed 2 of 6 pushes to main on an UPSTREAM
overload, and had no way to present that differently from a transport defect.
A job whose red is routinely correct-to-ignore is camouflage for one whose red
is not — which is how `E2E — Real LLM` stayed red for twelve consecutive pushes
unnoticed (#114).

THE MEASUREMENT THAT MOTIVATED THIS, from the real failing run 33315368062:

    {"type":"data-error","data":{"code":"backend_error",
     "message":"Service temporarily overloaded","retryable":false,
     "cause":{"exception":"APIError"}}}

`code` is `backend_error` and `retryable` is `false` — the FALL-THROUGH branch,
because a provider `APIError` carries no HTTP status. A `KeyError` from our own
emitter lands in exactly the same branch with exactly the same two values. The
two cases were indistinguishable in the payload, so no policy could treat them
differently.

BOTH DIRECTIONS ARE ASSERTED HERE, and that is the point of the file. A
classifier watched only agreeing with "provider" is indistinguishable from one
that returns "provider" unconditionally, and it would relabel every genuine
transport break as someone else's problem — strictly worse than today's red,
which is at least honest.
"""

import asyncio
import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ai_backends._common import _error_origin, guarded_stream  # noqa: E402

import anthropic  # noqa: E402
import openai  # noqa: E402

REQ = httpx.Request("POST", "http://provider.invalid/v1/chat")


def _frame(exc):
    """Drive the REAL guarded_stream path and return the parsed error frame.

    Not a hand-written fixture: the whole claim is about what this module
    actually emits, and a literal would assert what I believed it emitted.
    """

    async def gen():
        yield 'data: {"type":"text-start","id":"t1"}\n\n'
        raise exc

    async def run():
        return "".join([c async for c in guarded_stream(gen())])

    body = asyncio.run(run())
    line = next(l for l in body.split("\n") if '"data-error"' in l)
    return json.loads(line[len("data: ") :])["data"]


PROVIDER_CASES = [
    pytest.param(
        openai.APIError("Service temporarily overloaded", request=REQ, body=None),
        id="openai.APIError — the exact class the failing CI runs carried",
    ),
    pytest.param(
        openai.RateLimitError(
            "rate limited", response=httpx.Response(429, request=REQ), body=None
        ),
        id="openai.RateLimitError — a subclass, caught by the base check",
    ),
    pytest.param(
        anthropic.APIError("overloaded", request=REQ, body=None),
        id="anthropic.APIError — the other SDK",
    ),
]

BACKEND_CASES = [
    pytest.param(KeyError("tool_call_id"), id="KeyError in our emitter"),
    pytest.param(
        AttributeError("'NoneType' object has no attribute 'content_blocks'"),
        id="AttributeError — the shape a real port bug takes",
    ),
    pytest.param(ValueError("malformed frame"), id="ValueError"),
    pytest.param(RuntimeError("boom"), id="RuntimeError"),
]


@pytest.mark.parametrize("exc", PROVIDER_CASES)
def test_provider_failures_are_attributed_to_the_provider(exc):
    assert _error_origin(exc) == "provider"
    assert _frame(exc)["origin"] == "provider"


@pytest.mark.parametrize("exc", BACKEND_CASES)
def test_our_own_defects_are_attributed_to_us(exc):
    """THE HALF THAT MAKES THE OTHER HALF MEAN SOMETHING.

    Without these, `_error_origin` returning the constant "provider" passes
    every case above.
    """
    assert _error_origin(exc) == "backend"
    assert _frame(exc)["origin"] == "backend"


def test_code_alone_cannot_separate_them_which_is_why_origin_exists():
    """The measurement, kept as a test so the justification cannot rot.

    If a future change makes `code` discriminating on its own, this fails and
    whoever changed it gets to decide whether `origin` is still earning its
    keep — rather than it silently becoming redundant.
    """
    upstream = _frame(openai.APIError("Service temporarily overloaded", request=REQ, body=None))
    defect = _frame(KeyError("tool_call_id"))

    assert upstream["code"] == defect["code"] == "backend_error"
    assert upstream["retryable"] == defect["retryable"] is False
    assert upstream["origin"] != defect["origin"]


def test_an_unknown_exception_is_ours_not_theirs():
    """The default direction is a decision, not an accident.

    Calling our defect an upstream problem stops it being investigated; calling
    an upstream problem ours costs someone a look at a red that was not their
    fault. Only one of those is recoverable.
    """

    class SomethingNobodyAnticipated(Exception):
        pass

    assert _error_origin(SomethingNobodyAnticipated("?")) == "backend"

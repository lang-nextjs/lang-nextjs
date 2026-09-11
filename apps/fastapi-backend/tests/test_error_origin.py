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
import inspect
import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ai_backends._common import (  # noqa: E402
    MISSING_CREDENTIAL_FINGERPRINT,
    _error_code,
    _error_origin,
    _is_missing_credential_error,
    guarded_stream,
)

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


# ── MISSING CREDENTIALS (#1196) ─────────────────────────────────────────────
#
# langchain_anthropic re-raises the underlying anthropic SDK's
# TypeError("Could not resolve authentication method") as a plain TypeError
# with a guidance message about setting ANTHROPIC_API_KEY. The class is too
# broad to match on, so we fingerprint the message and assert the fingerprint
# still appears in the installed langchain_anthropic source — so a vendor
# reword becomes a failing test, not a silent regression.


REAL_MISSING_KEY_MESSAGE = (
    "Anthropic authentication failed: no API key or authorization credentials "
    "were provided. Set the ANTHROPIC_API_KEY environment variable, "
    "pass api_key=... to ChatAnthropic, or provide credentials via "
    'default_headers={"Authorization": ...}. If you are routing through the '
    "LangSmith gateway, set LANGSMITH_GATEWAY and LANGSMITH_GATEWAY_API_KEY."
)


def test_pin_missing_credential_fingerprint():
    """The fingerprint in `_common.py` MUST appear in the installed package source.

    A reword in langchain_anthropic would silently turn missing-key errors
    back into TRANSPORT_DEFECT. This is the guard that catches it.
    """
    try:
        from langchain_anthropic import chat_models
    except ImportError:
        pytest.skip("langchain_anthropic not installed in this tree")

    src = inspect.getsource(chat_models._raise_if_authentication_error)
    assert MISSING_CREDENTIAL_FINGERPRINT in src, (
        "langchain_anthropic's missing-credentials message has drifted. "
        "Re-pin MISSING_CREDENTIAL_FINGERPRINT in _common.py from the new text "
        "and update the classifier's fixture in classify-live-failure.selftest.mjs "
        "to match — both pins must move together, otherwise the partition "
        "stops matching what the producer emits."
    )


def test_missing_credential_typeerror_is_recognised():
    """The fingerprint match returns True on a real missing-credential TypeError,
    and False on every other TypeError — so the match is selective, not
    a catch-all that would re-route every TypeError in the system.
    """
    assert _is_missing_credential_error(TypeError(REAL_MISSING_KEY_MESSAGE)) is True
    # Other TypeErrors are NOT missing-credential, even with the same class.
    assert _is_missing_credential_error(TypeError("unrelated")) is False
    # A non-TypeError with the same message is not the SDK's re-raise, and a
    # class-only check would let it through. The `isinstance(exc, TypeError)`
    # half closes that door.
    assert _is_missing_credential_error(ValueError(REAL_MISSING_KEY_MESSAGE)) is False


def test_missing_credential_emits_missing_credential_code():
    """A missing-credential TypeError becomes `code=missing_credential`, distinct
    from the `backend_error` fallthrough a plain TypeError would otherwise land in.

    `code` is the only field the classifier reads for the durable/transient
    split, and the partition would lose this case entirely if it shared
    `backend_error` with everything else.
    """
    code, retryable = _error_code(TypeError(REAL_MISSING_KEY_MESSAGE))
    assert code == "missing_credential"
    assert retryable is False


def test_missing_credential_frame_keeps_backend_origin():
    """The missing-credential frame's `origin` is still `backend` — it's our
    backend's env, not the provider's fault — but the `code` separates it
    from a code defect. A reader using only `origin` would still see "ours";
    a reader using `code` sees the specific reason.
    """
    frame = _frame(TypeError(REAL_MISSING_KEY_MESSAGE))
    assert frame["origin"] == "backend"
    assert frame["code"] == "missing_credential"
    assert frame["retryable"] is False

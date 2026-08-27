"""A backend failure reaches the user as itself, not as a disconnect.

Reported in #247: chat failed on every attempt with

    upstream backend disconnected mid-stream

while this process was holding the actual, actionable reason:

    openai.APIStatusError: Error code: 410 - {'title': 'Gone', 'detail':
    "The model 'meta/llama-3.3-70b-instruct' has reached its end of life on
    2026-08-26T09:00:00Z and is no longer available."}

One environment variable would have fixed it. The person who could set it was
told the connection had dropped.

THE PROXY WAS NOT WRONG. `StreamingResponse` flushes 200 before it iterates, so
an exception from the generator closes the socket with no terminal frame — and
a 200 that ends without one IS a mid-stream disconnect from where the proxy
sits. The two failures are indistinguishable on the wire, which is why they
have to be separated in this process, the last one that still holds the reason.

Each case below is a PAIR of assertions, and both halves are load-bearing:
emitting the error without the trailing `finish` leaves the proxy still
reporting a disconnect, so the client would show the real cause AND the lie
that displaced it.

These run in CI: the `python` job in ci.yml installs the backend's
requirements and runs pytest. That job is #80's other half — until it existed,
this file carried a note in prose saying nothing executed it, which is a comment
standing where a job was needed. Tests nothing runs look exactly like coverage,
and read as coverage in review.
"""

import asyncio
import json

import pytest

from ai_backends import _common


def _drain(agen):
    """Collect emitted frames as parsed dicts, in order.

    Sync on purpose: `pytest-asyncio` is not in the backend image, and an
    unregistered `@pytest.mark.asyncio` does not fail — it SKIPS the body and
    reports a pass. Six tests "passed" that way before this was caught, which
    is the same vacuous-check shape these tests exist to prevent.
    """

    async def run():
        out = []
        async for chunk in agen:
            for line in chunk.split("\n"):
                line = line.strip()
                if line.startswith("data:"):
                    out.append(json.loads(line[5:].strip()))
        return out

    return asyncio.run(run())


def _types(frames):
    return [f.get("type") for f in frames]


async def _clean_stream():
    yield 'data: {"type":"text-start","id":"text-1"}\n\n'
    yield 'data: {"type":"text-delta","id":"text-1","delta":"hi"}\n\n'
    yield 'data: {"type":"text-end","id":"text-1"}\n\n'
    yield 'data: {"type":"finish","finishReason":"stop"}\n\n'


class _Gone(Exception):
    """Shaped like the provider error in the report: it carries a status."""

    status_code = 410

    def __str__(self):
        return (
            "Error code: 410 - {'title': 'Gone', 'detail': \"The model "
            "'meta/llama-3.3-70b-instruct' has reached its end of life on "
            '2026-08-26T09:00:00Z and is no longer available."}'
        )


def test_a_clean_stream_is_passed_through_untouched():
    """The half that fails against a wrapper that rewrites everything.

    Without this, "always emit an error frame" would satisfy every other test
    in the file.
    """
    frames = _drain(_common.guarded_stream(_clean_stream()))
    assert _types(frames) == ["text-start", "text-delta", "text-end", "finish"]
    assert not any(f.get("type") == "data-error" for f in frames)


def test_the_provider_reason_survives_to_the_client():
    async def boom():
        yield 'data: {"type":"text-start","id":"text-1"}\n\n'
        raise _Gone()

    frames = _drain(_common.guarded_stream(boom()))
    err = next(f for f in frames if f["type"] == "data-error")

    # THE POINT OF THE ISSUE: the model name and the EOL date are what make
    # this fixable, and they are exactly what the old path discarded.
    assert "end of life" in err["data"]["message"]
    assert "meta/llama-3.3-70b-instruct" in err["data"]["message"]
    assert err["data"]["code"] == "upstream_410"
    assert err["data"]["retryable"] is False


def test_the_stream_still_ends_the_way_a_finished_stream_ends():
    """Otherwise the proxy reports a disconnect ON TOP of the real error.

    This is the half that makes the fix complete rather than merely present:
    the error frame alone still leaves the stream terminal-frame-less, which is
    the precise condition that produced the false disconnect.
    """

    async def boom():
        yield 'data: {"type":"text-start","id":"text-1"}\n\n'
        raise _Gone()

    frames = _drain(_common.guarded_stream(boom()))
    assert _types(frames)[-1] == "finish"
    assert frames[-1]["finishReason"] == "error"


def test_an_open_text_block_is_closed_before_the_error():
    """An unterminated text-start renders as a hang, not as a failure.

    Same misattribution as the issue itself, one layer down: the client would
    sit on a text part that never completes.
    """

    async def boom():
        yield 'data: {"type":"text-start","id":"text-1"}\n\n'
        yield 'data: {"type":"text-delta","id":"text-1","delta":"partial"}\n\n'
        raise _Gone()

    frames = _drain(_common.guarded_stream(boom()))
    types = _types(frames)
    assert "text-end" in types
    assert types.index("text-end") < types.index("data-error")


def test_a_client_going_away_is_not_reported_as_a_backend_error():
    """CancelledError must propagate.

    It is how a client disconnecting arrives here. Nobody is left to read the
    frame, and reporting one would invent an error the run never had — the
    same class of lie this module exists to remove, pointed the other way.
    """
    import asyncio

    async def cancelled():
        yield 'data: {"type":"text-start","id":"text-1"}\n\n'
        raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        _drain(_common.guarded_stream(cancelled()))


def test_a_transient_upstream_failure_is_marked_retryable():
    """503 and 429 are worth retrying unchanged; a 410 never is."""

    class _Overloaded(Exception):
        status_code = 503

    async def boom():
        raise _Overloaded()
        yield  # pragma: no cover — makes this an async generator

    frames = _drain(_common.guarded_stream(boom()))
    err = next(f for f in frames if f["type"] == "data-error")
    assert err["data"]["code"] == "upstream_503"
    assert err["data"]["retryable"] is True

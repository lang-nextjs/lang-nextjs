"""What a turn cost reaches the client, on the django plane too (#714).

THIS PLANE HAD THE DEFECT AND NONE OF THE COVERAGE. #300 added per-turn usage
reporting to both python backends in the same shape; only fastapi got
tests/test_turn_usage.py. So when the shape turned out to be one AI SDK v6
rejects — `totalUsage` at the top level of `finish`, which is the SDK's
onFinish/StepResult CALLBACK shape and not the wire chunk — fastapi had three
green tests asserting the broken key and django had nothing at all. Neither
plane could see it, but only one of them looked.

The value assertions here mirror fastapi's deliberately: identical inputs and
identical expectations, so a divergence between the planes shows up as a diff
between two files rather than as an absence in one. The conformance assertions
come from scripts/sse_frame_conformance.py, which both planes drive, so "no
undeclared key" has ONE definition rather than one per plane.

These run in CI: the `python` job in ci.yml installs this backend's requirements
and runs pytest.
"""

import json

import pytest

# THIS FILE'S SUBJECT LEAVES WITH RUNG 3. The file is SHARED so it survives every
# eject; `ai_backends/deepagents.py` is rung-owned and is correctly deleted.
# importorskip rather than try/except: a SKIP IS NOT A PASS, and pytest reports
# this one by name with the reason attached, where a swallowed ImportError would
# leave a green suite that silently stopped covering the emitter.
deepagents = pytest.importorskip(
    "deepagents_backend.ai_backends.deepagents",
    reason="rung 3 (deepagents) is not in this tree; its emitter is what this file drives",
)

from sse_frame_conformance import (  # noqa: E402  — after the importorskip above
    declared_properties,
    load_schema,
    parse_frames,
    undeclared_property_failures,
)


class _Chunk:
    """An AIMessageChunk as this code path actually uses it."""

    def __init__(self, text="", usage=None):
        self.content = text
        self.content_blocks = [{"type": "text", "text": text}] if text else []
        self.tool_calls = []
        self.tool_call_chunks = []
        self.usage_metadata = usage


class _Graph:
    """A graph whose astream replays a fixed sequence of message chunks."""

    def __init__(self, chunks):
        self._chunks = chunks

    def astream(self, *_args, **_kwargs):
        chunks = self._chunks

        async def gen():
            for c in chunks:
                # (namespace, mode, (message, metadata)) — the main agent, so
                # the namespace is empty.
                yield ((), "messages", (c, {}))

        return gen()


async def _drain(graph):
    out = []
    async for piece in deepagents._emit_ai_sdk_v6(
        graph, [{"role": "user", "content": "hi"}]
    ):
        out.append(piece)
    return "".join(out)


def _finish_frame(raw):
    for line in raw.split("\n"):
        line = line.strip()
        if line.startswith("data:") and '"finish"' in line:
            return json.loads(line[5:].strip())
    return None


def _run(graph):
    import asyncio

    return asyncio.run(_drain(graph))


def test_usage_reaches_the_finish_frame():
    raw = _run(
        _Graph([
            _Chunk("hello"),
            _Chunk("", {"input_tokens": 100, "output_tokens": 7, "total_tokens": 107}),
        ])
    )
    finish = _finish_frame(raw)
    assert finish is not None
    assert finish["messageMetadata"]["totalUsage"] == {
        "inputTokens": 100,
        "outputTokens": 7,
        "totalTokens": 107,
    }


def test_usage_from_several_model_calls_is_summed():
    """A turn is not one model call.

    plan-execute makes several. Overwriting instead of summing would report the
    last call's cost as the turn's, which is wrong in the direction that looks
    plausible — a smaller number nobody questions.
    """
    raw = _run(
        _Graph([
            _Chunk("a", {"input_tokens": 10, "output_tokens": 1, "total_tokens": 11}),
            _Chunk("b", {"input_tokens": 20, "output_tokens": 2, "total_tokens": 22}),
        ])
    )
    assert _finish_frame(raw)["messageMetadata"]["totalUsage"] == {
        "inputTokens": 30,
        "outputTokens": 3,
        "totalTokens": 33,
    }


def test_a_provider_that_reports_nothing_claims_nothing():
    """The half that keeps the number honest.

    Emitting a zeroed usage block would assert the turn was free — a claim the
    backend has no basis for, and indistinguishable downstream from a real zero.
    Absence must stay absent.
    """
    raw = _run(_Graph([_Chunk("hello")]))
    finish = _finish_frame(raw)
    assert finish is not None
    assert "messageMetadata" not in finish


def test_the_contract_still_describes_a_finish_frame():
    """Positive control for the two tests below.

    Both are "nothing undeclared" assertions, and an absence assertion passes
    trivially against a contract that stopped declaring the frame at all — the
    helper returns None for an unknown kind and the check skips it. This one
    fails in that case, so a green there cannot come from a contract that no
    longer says anything.
    """
    declared = declared_properties(load_schema(), "finish")
    assert declared is not None, "the contract declares no `finish` frame"
    assert {"type", "finishReason", "messageMetadata"} <= declared, declared


def test_a_finish_frame_carrying_usage_carries_nothing_undeclared():
    raw = _run(
        _Graph([
            _Chunk("hello"),
            _Chunk("", {"input_tokens": 100, "output_tokens": 7, "total_tokens": 107}),
        ])
    )
    assert undeclared_property_failures(parse_frames(raw)) == []


def test_a_finish_frame_without_usage_carries_nothing_undeclared():
    raw = _run(_Graph([_Chunk("hello")]))
    assert undeclared_property_failures(parse_frames(raw)) == []

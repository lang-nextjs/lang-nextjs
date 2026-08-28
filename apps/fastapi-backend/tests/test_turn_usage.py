"""What a turn cost reaches the client, and a free turn is never claimed.

#232: usage was captured upstream and never reported, so every layer above the
model said a turn cost nothing. The real-LLM e2e suite is the place it showed:

    expected at least one real-LLM signal: totalUsage.outputTokens>0 (got 0)
    OR text-delta count>=3 (got 1). Both failing suggests a canned/stub
    response, not a real model call.

Both halves of that check were unreliable — the token count because nothing
emitted it, the delta count because a short answer legitimately arrives in one
chunk. A test that cannot tell a real model from a stub is the shape this repo
keeps finding.

TWO CAUSES, AND ONLY ONE IS OBVIOUS. The emitting code is the visible half; the
other is that the OpenAI wire format OMITS usage from a streamed response
unless `stream_usage=True` is requested, so `usage_metadata` was None on every
chunk. Measured before the fix: "usage_metadata observed: NONE" across a whole
run; after: input_tokens 3106, output_tokens 66.

These run in CI: the `python` job in ci.yml installs the backend's requirements
and runs pytest.
"""

import json

from ai_backends import deepagents


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
    async for piece in deepagents._emit_ai_sdk_v6(graph, [{"role": "user", "content": "hi"}]):
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
    assert finish["totalUsage"] == {
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
    assert _finish_frame(raw)["totalUsage"] == {
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
    assert "totalUsage" not in finish

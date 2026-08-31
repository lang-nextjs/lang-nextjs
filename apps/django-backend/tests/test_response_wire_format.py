"""E2E-01: the django plane EMITS the DeepAgents SSE wire format VIA StreamingHttpResponse.

THE VERBS DECIDE THE SUBJECT. The requirement says EMITS and VIA, so a test that
imports a module and finds a symbol does not falsify it, and neither does one
that inspects a generator. Only a RESPONSE does.

That is the same subject apps/fastapi-backend/tests/test_response_wire_format.py
picked, and its docstring gives the reason: without `media_type` FastAPI answers
application/json while a generator-level assertion stays green. Django has the
same hole with a different spelling — `StreamingHttpResponse(...)` without
`content_type=` defaults to text/html, and every frame still arrives.

WHY THESE TESTS ARE SYNCHRONOUS around an async call. The view is async, so the
natural spelling is `@pytest.mark.asyncio`. ci.yml's own comment records what
that costs: with `--strict-markers` and no pytest-asyncio installed, the marker
does not fail — IT SKIPS THE BODY AND REPORTS A PASS. Six tests "passed" that way
while landing #288. `asyncio.run()` in a plain `def` needs no marker and no
plugin, so there is no configuration under which these can pass without running.

WHAT THIS FILE DOES NOT COVER — see the report on #508. It asserts the RESPONSE
ENVELOPE (status, content-type, anti-buffering headers) and that frames reach the
client. It does not assert the FRAME GRAMMAR, does not exercise a real adapter or
model, and does not compare django's output to fastapi's — that comparison is
#527 and there is no shared definition to compare against today.
"""

import asyncio
import json

from django.test import AsyncClient

from deepagents_backend import views


def _ok_stream(_messages, **_kwargs):
    """A stub topology, so nothing here reaches a model.

    Yields already-framed strings, which is the same shape a real adapter yields
    — and exactly why this file asserts nothing about that framing.
    """

    async def gen():
        yield 'data: {"type":"text-start","id":"t1"}\n\n'
        yield 'data: {"type":"text-delta","id":"t1","delta":"hi"}\n\n'
        yield 'data: {"type":"text-end","id":"t1"}\n\n'
        yield 'data: {"type":"finish","finishReason":"stop"}\n\n'

    return gen()


class _FakeModule:
    TOPOLOGIES = {"probe": _ok_stream}
    # Required of every module (#261): the dispatch reads this as a plain
    # attribute, so a module that omits it crashes on the first request rather
    # than quietly gating nothing. This probe gates neither topology, and says so.
    GATED_TOPOLOGIES = frozenset()


def _post(path, body):
    async def go():
        client = AsyncClient()
        return await client.post(
            path, data=json.dumps(body), content_type="application/json"
        )

    return asyncio.run(go())


def _stream_body(response):
    async def drain():
        chunks = []
        async for chunk in response.streaming_content:
            chunks.append(
                chunk.decode() if isinstance(chunk, bytes) else str(chunk)
            )
        return "".join(chunks)

    return asyncio.run(drain())


def _probe(monkeypatch):
    monkeypatch.setitem(views._MODULES, "wire-probe", _FakeModule)
    return _post(
        "/api/chat/stream/wire-probe/",
        {"messages": [{"role": "user", "content": "hi"}], "topology": "probe"},
    )


def test_content_type_is_event_stream_not_html(monkeypatch):
    """Drop `content_type=` from the StreamingHttpResponse and this fails.

    Django defaults to text/html, which the proxy will not treat as a stream.
    """
    response = _probe(monkeypatch)
    assert response.status_code == 200
    assert response["Content-Type"].startswith("text/event-stream"), (
        f"django answered {response['Content-Type']!r} — the client's SSE parser "
        f"needs text/event-stream, and every frame still arrives without it"
    )


def test_the_anti_buffering_headers_are_present(monkeypatch):
    """THE FAILURE THESE PREVENT IS SILENT. Drop them and every frame still
    arrives, in one batch, after the run finishes — which looks like a slow
    model rather than a buffered proxy."""
    response = _probe(monkeypatch)
    assert response["Cache-Control"] == "no-cache"
    assert response["X-Accel-Buffering"] == "no"


def test_the_frames_actually_reach_the_client(monkeypatch):
    """Without this, the header assertions above are satisfied by an SSE-typed
    response carrying nothing — a correct envelope around an empty stream."""
    response = _probe(monkeypatch)
    body = _stream_body(response)
    assert "text-delta" in body, f"no frames in the streamed body: {body!r}"
    assert body.count("data:") == 4, (
        f"expected the stub's four frames, got {body.count('data:')}: {body!r}"
    )


def test_CONTROL_a_non_stream_route_is_json_not_event_stream(monkeypatch):
    """The content-type assertion is only evidence if it can distinguish.

    An unknown ai_backend takes the 404 branch, which returns JsonResponse. If
    THIS also came back as text/event-stream, the first test would be asserting a
    property of the framework rather than of the streaming path.
    """
    response = _post(
        "/api/chat/stream/no-such-backend/",
        {"messages": [{"role": "user", "content": "hi"}]},
    )
    assert response.status_code == 404
    assert not response["Content-Type"].startswith("text/event-stream"), (
        "the 404 branch is also text/event-stream, so content-type does not "
        "distinguish the streaming path and the first test proves nothing"
    )

"""The RESPONSE is SSE — asserted on a response, not on a generator.

E2E-02 of #222. The audit ticked "fastapi emits SSE wire format" and found no
test. Every `data:` line in this directory turned out to be a FIXTURE THE TEST
ITSELF WRITES: the test hands `guarded_stream` a hand-written SSE string and
checks what comes back out. The wire format appears in the assertion because the
test put it in the input.

That is the same shape as ADAPT-01 in the same issue — a check that constructs
the thing it claims to verify — and it leaves four properties of the actual
endpoint with nothing watching them:

    media_type="text/event-stream"          delete it -> content-type becomes
                                            application/json; the proxy's
                                            EventSource parse fails at frame 1
    Cache-Control / X-Accel-Buffering       delete them -> nginx buffers the
                                            whole stream and delivers it at the
                                            end; every token arrives at once,
                                            and NOTHING ERRORS
    _common.guarded_stream(...)             unwrap it -> #247 comes straight
                                            back: a provider 410 reaches the
                                            user as "disconnected mid-stream"
    404 on unknown backend/topology         these must stay JSON errors, not
                                            200 streams carrying an error frame

Not one of those survives in a test that calls the generator directly. All four
are asserted below through the real ASGI app, and each was confirmed by breaking
the route and watching this file fail.

WHAT IS DELIBERATELY NOT HERE: the framing of individual frames. `stream_fn`
yields already-framed strings, so a stub that emits them would put the answer in
the input all over again. Per-adapter framing is tested with its own rung, where
the adapter that produces it lives.
"""

import json

import pytest
from fastapi.testclient import TestClient

import main
from sse_frame_conformance import conformance_failures, parse_frames


# A stub topology, so nothing below reaches a model. It yields the SAME shape a
# real adapter yields — already-framed strings — which is exactly why this file
# asserts nothing about that framing.
def _ok_stream(_messages):
    async def gen():
        yield 'data: {"type":"text-start","id":"t1"}\n\n'
        yield 'data: {"type":"text-delta","id":"t1","delta":"hi"}\n\n'
        yield 'data: {"type":"text-end","id":"t1"}\n\n'
        yield 'data: {"type":"finish","finishReason":"stop"}\n\n'

    return gen()


def _raising_stream(_messages):
    async def gen():
        yield 'data: {"type":"text-start","id":"t1"}\n\n'
        raise RuntimeError(
            "Error code: 410 - the model has reached its end of life"
        )
        yield ""  # unreachable; keeps this an async generator

    return gen()


class _FakeModule:
    TOPOLOGIES = {"probe": _ok_stream, "boom": _raising_stream}
    # REQUIRED OF EVERY MODULE (#261). The dispatch reads this as a plain attribute so a
    # module that forgets it crashes on the first request rather than quietly gating
    # nothing. This probe gates neither of its topologies, and says so.
    GATED_TOPOLOGIES = frozenset()


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setitem(main._MODULES, "wire-probe", _FakeModule)
    return TestClient(main.app)


def _post(client, path, topology="probe"):
    body = {"messages": [{"role": "user", "content": "hi"}]}
    if topology is not None:
        body["topology"] = topology
    return client.post(path, json=body)


def _frames(body: str):
    out = []
    for line in body.split("\n"):
        line = line.strip()
        if line.startswith("data:"):
            payload = line[5:].strip()
            if payload and payload != "[DONE]":
                out.append(json.loads(payload))
    return out


def test_content_type_is_event_stream_not_json(client):
    """Without `media_type`, FastAPI answers application/json and the proxy's
    stream parser fails on the first frame."""
    r = _post(client, "/api/chat/stream/wire-probe")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")


def test_the_anti_buffering_headers_are_present(client):
    """THE FAILURE THESE PREVENT IS SILENT. Drop them and every frame still
    arrives, in order, complete — just all at once, after the model has
    finished. The stream stops streaming and nothing reports an error, so only
    an assertion on the headers can catch it."""
    r = _post(client, "/api/chat/stream/wire-probe")
    assert r.headers.get("cache-control") == "no-cache"
    assert r.headers.get("x-accel-buffering") == "no"


def test_the_frames_conform_to_the_published_schema(client):
    """#550 — docs/sse-frame-schema.json meets a PYTHON response for the first time.

    The schema has been Ajv-validated since #59 and every consumer was
    TypeScript, so "both planes emit the same wire format" rested on the two
    planes agreeing with each other (#527) and on neither being checked against
    the published declaration.

    Conformance rules live in scripts/sse_frame_conformance.py and django drives
    the same ones — one definition, two real responses.
    """
    r = _post(client, "/api/chat/stream/wire-probe")
    frames = parse_frames(r.text)
    assert conformance_failures(frames) == []


def test_a_raising_adapter_reaches_the_client_as_its_own_reason(client):
    """#247, through the route for the first time.

    The existing tests call `guarded_stream` directly, so they pass whether or
    not `chat_stream` actually wraps the generator. Unwrap it in main.py and the
    body below ends after text-start with no terminal frame — which the proxy
    reads, correctly, as a mid-stream disconnect. The real cause was in this
    process the whole time.

    Both halves are load-bearing: an error frame WITHOUT the trailing finish
    still leaves the proxy reporting a disconnect, so the user would see the
    real cause and the lie that displaced it, together."""
    body = _post(client, "/api/chat/stream/wire-probe", topology="boom").text
    types = [f.get("type") for f in _frames(body)]
    assert "data-error" in types, f"no error frame; got {types}"
    assert types[-1] == "finish", f"stream does not terminate; got {types}"
    err = next(f for f in _frames(body) if f.get("type") == "data-error")
    assert "410" in json.dumps(err), f"the reason did not survive: {err}"


def test_unknown_backend_is_a_json_404_not_a_200_stream(client):
    """A 200 carrying an error frame and a 404 are different things to the
    proxy: the first is a conversation that failed, the second is a request that
    was never valid. Collapsing them hides configuration errors inside chats."""
    r = _post(client, "/api/chat/stream/no-such-backend")
    assert r.status_code == 404
    assert not r.headers["content-type"].startswith("text/event-stream")
    assert "no-such-backend" in r.text


def test_unknown_topology_is_a_404_that_names_the_valid_ones(client):
    r = client.post(
        "/api/chat/stream/wire-probe",
        json={"messages": [{"role": "user", "content": "hi"}], "topology": "nope"},
    )
    assert r.status_code == 404
    assert "probe" in r.text, f"the 404 does not say what IS valid: {r.text}"

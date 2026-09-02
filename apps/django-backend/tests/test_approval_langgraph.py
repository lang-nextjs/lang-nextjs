"""The langgraph rung gates react on THIS plane too, and per tool (#332 steps C2/C3).

The mirror of apps/fastapi-backend/tests/test_approval_langgraph.py. Its header carries
the measurement that chose this rung's mechanism; what follows is why the case is worth
running twice rather than inferred from parity.

`check-run-axes-parity` holds the two planes' `stream_chat_react` and their
`GATED_TOPOLOGIES` byte-identical since #592, so the code and the declaration are known
to agree. That is still not the behaviour agreeing: both planes' langgraph backends
could be identically wired to a `post_model_hook` that never fires, and parity would be
green because they are wrong in the same way. Identity is a claim about drift, never
about correctness, and this file is the second observation rather than a second copy of
the first one's conclusion.
"""

import asyncio
import json

import pytest
from django.test import AsyncClient
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver

# THIS FILE SURVIVES AN EJECT AND THE MODULE IT DRIVES DOES NOT (#588).
#
# Measured, not anticipated: `node scripts/eject.mjs langchain` prunes
# deepagents_backend.ai_backends.langgraph and keeps this file, and a module-level
# `import deepagents_backend.ai_backends.langgraph` then fails at COLLECTION -- which does not
# fail one test, it takes the whole suite down with
# "Interrupted: 1 error during collection". 2 skipped, 1 error, nothing else ran.
#
# So the import is guarded, and the guard is honest about what it means: in a fork
# below this rung the backend genuinely is not there, so its behaviour cannot be
# observed and there is nothing here to be wrong about. It is a skip because the
# SUBJECT is absent, not because the assertion was inconvenient -- the distinction
# this repo keeps having to relearn.
lg = pytest.importorskip(
    "deepagents_backend.ai_backends.langgraph",
    reason="the langgraph rung is not in this tree (it was ejected)",
)

MESSAGES = [{"role": "user", "content": "increment it by 1"}]
# `get_counter` is read-only and therefore NOT gated; `increment` is.
POLICY = {"approvalPolicy": {"readOnlyTools": ["read_file", "get_counter"]}}


class ScriptedModel(FakeMessagesListChatModel):
    """A fake chat model that accepts `bind_tools`."""

    def bind_tools(self, tools, **kwargs):  # noqa: ARG002
        return self


def _effects(monkeypatch, call_tool):
    """Script the model to call `call_tool`, and count what each tool actually did.

    BOTH TOOLS RECORD. A test counting only `increment` cannot tell "the allowlisted
    call was not gated" from "the allowlisted call never happened" — both leave that
    counter at zero.
    """
    counts = {"increment": 0, "get_counter": 0}

    @tool
    def increment(by: int = 1) -> str:
        """Increment the counter."""
        counts["increment"] += by
        return f"Counter incremented to {counts['increment']}"

    @tool
    def get_counter() -> str:
        """Read the counter."""
        counts["get_counter"] += 1
        return "0"

    model = ScriptedModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[{"name": call_tool, "args": {}, "id": "call-1"}],
            ),
            AIMessage(content="done"),
        ]
    )
    monkeypatch.setattr(lg, "make_llm", lambda: model)
    monkeypatch.setattr(lg, "TOOLS", [increment, get_counter])
    monkeypatch.setattr(lg, "_react_graph", None)
    return counts


def _post(*, topology="react", policy=True, session=True):
    body = {"messages": MESSAGES, "topology": topology, "aiBackend": "langgraph"}
    if policy:
        body.update(POLICY)
    if session:
        body["sessionId"] = "sess-django-lg"

    async def go():
        client = AsyncClient()
        res = await client.post(
            "/api/chat/stream/langgraph/",
            data=json.dumps(body),
            content_type="application/json",
        )
        chunks = []
        async for chunk in res.streaming_content:
            chunks.append(chunk.decode() if isinstance(chunk, bytes) else str(chunk))
        return res, "".join(chunks)

    return asyncio.run(go())


def _approval_frames(text):
    """Every `approval_pending` payload in an SSE body, parsed."""
    out = []
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if line.strip() == "event: approval_pending":
            data = lines[i + 1]
            assert data.startswith("data: "), data
            out.append(json.loads(data[len("data: ") :]))
    return out


def _proceeded(res, text):
    """200 AND no error frame. A 200 alone is set before the generator runs."""
    return res.status_code == 200 and "data-error" not in text


def test_the_SHIPPED_configuration_gates_react(monkeypatch):
    """NO monkeypatch of GATED_TOPOLOGIES — the one case that fails if this set is empty."""
    counts = _effects(monkeypatch, "increment")
    res, text = _post()
    assert _proceeded(res, text), text
    assert counts["increment"] == 0, (
        "the shipped configuration did not withhold the call on this plane; either "
        "react left langgraph's GATED_TOPOLOGIES or the gate is not wired to it"
    )
    assert _approval_frames(text), (
        "the call was withheld and the client was told nothing — a 200 whose only "
        "distinguishing feature is an absence"
    )


def test_an_ALLOWLISTED_tool_is_NOT_gated_and_RUNS(monkeypatch):
    """The per-tool case, and the one that would fail under `interrupt_before=["tools"]`."""
    counts = _effects(monkeypatch, "get_counter")
    res, text = _post()
    assert _proceeded(res, text), text
    assert counts["get_counter"] == 1, (
        "an allowlisted read-only tool did not run; the gate is coarser than the "
        "policy it claims to implement, and this plane now disagrees with the other "
        "one about the same request"
    )
    assert not _approval_frames(text), (
        "an allowlisted tool produced an approval request, so a person is being asked "
        "to approve something the policy already excused"
    )


def test_the_ungated_control_DOES_run_the_tool(monkeypatch):
    """The companion a disarming mutation must leave GREEN."""
    counts = _effects(monkeypatch, "increment")
    monkeypatch.setattr(lg, "GATED_TOPOLOGIES", frozenset())
    res, text = _post(policy=False, session=False)
    assert _proceeded(res, text), text
    assert counts["increment"] == 1, (
        "the tool did not run even with the gate off, so the withholding measured "
        "above is not evidence the gate did anything"
    )


def test_the_payload_carries_the_action_and_the_decisions(monkeypatch):
    """The authored shape, asserted on this plane rather than inferred from the other."""
    _effects(monkeypatch, "increment")
    res, text = _post()
    frames = _approval_frames(text)
    assert len(frames) == 1, frames
    payload = frames[0]["interrupt"]

    # THE KEYS THE CARD PARSES, not the ones this rung finds convenient.
    # docs/sse-frame-schema.json calls action_requests paired BY INDEX with
    # review_configs "the client's only source for which controls to offer", and
    # packages/react's ApprovalPauseSchema reads exactly these. The first version
    # of this assertion pinned `action_requests[].action_name` and a top-level
    # `allowed_decisions` -- the shape #332's issue body quotes, which neither
    # upstream middleware emits -- so the test was green over a payload the card
    # would have rejected. A fixture sharing the blind spot of what it tests.
    assert [r["name"] for r in payload["action_requests"]] == ["increment"], payload
    assert "action_name" not in payload["action_requests"][0], (
        "action_requests entries key the tool as `name`; `action_name` belongs to "
        "review_configs, and the card reads them from different places"
    )

    from deepagents_backend.ai_backends._common import _DECISION_TYPES

    assert [c["action_name"] for c in payload["review_configs"]] == ["increment"], payload
    assert payload["review_configs"][0]["allowed_decisions"] == list(_DECISION_TYPES), payload
    assert len(payload["review_configs"]) == len(payload["action_requests"]), (
        "review_configs pairs with action_requests BY INDEX; a length mismatch "
        "silently offers one call's controls for another's"
    )


def test_a_GATED_run_is_still_traced(monkeypatch):
    """The gated path calls langfuse_config(), and this is a behavioural check.

    THE DEFECT THIS EXISTS FOR, which shipped in the first version of this rung's
    dispatch: `config = approval_thread_config() if gated else langfuse_config()`.
    A ternary, choosing between the two configs instead of merging them, so every
    gated turn ran with no callbacks and no metadata while `/health` went on
    reporting the backend as traced. An endpoint made to lie by one line.

    check-langfuse-wiring caught it, and it reads the SOURCE for a literal
    `config=langfuse_config()` at each invocation. That is a good gate and it is
    not this one: a call site can carry the literal and still not reach it, and
    this asserts the function was actually CALLED while the gate was active.

    NOT ASSERTED HERE: that the callbacks reach Langfuse. That needs a live
    endpoint, and `langfuse_probe` is where it is asked.
    """
    counts = _effects(monkeypatch, "increment")
    calls = []
    real = lg.langfuse_config

    def counting():
        calls.append(1)
        return real()

    monkeypatch.setattr(lg, "langfuse_config", counting)
    res, text = _post()
    assert _proceeded(res, text), text
    assert counts["increment"] == 0, "precondition: this run must be the gated one"
    assert calls, (
        "a gated run never called langfuse_config(), so it ran untraced while "
        "/health reports this backend as traced"
    )

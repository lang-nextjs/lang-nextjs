"""The deepagents rung gates react, and its pause is an AI SDK PART (#332 steps C4/C5).

WHY THIS RUNG NEEDS ITS OWN WITNESS RATHER THAN INHERITING THE OTHERS'. Its gate
is a third mechanism -- `create_deep_agent(interrupt_on=...)` -- and, more
importantly, its WIRE IS DIFFERENT. langchain and langgraph emit
`event: approval_pending` and an adapter converts it into a
`data-approval-pause` part. This backend already speaks AI SDK v6 and
`deepagentsAdapter` only strips messageId from finish frames, so there is nothing
downstream to convert an `event:` frame. A rung emitting one would put the pause
on the wire in a shape no layer reads -- which is precisely what the langgraph
rung did until #332 step C2 measured it, and the reason that measurement is worth
repeating here rather than assuming the third rung inherits the fix.

MEASURED AGAINST deepagents 0.7.11 BEFORE ANY OF THIS WAS WRITTEN:

    gated tool        0 effects at the pause, 1 interrupt, effect runs on resume
    allowlisted tool  no pause, no interrupt, and the tool RAN

THE PAYLOAD IS NOT AUTHORED HERE, unlike the langgraph rung's. deepagents builds
the interrupt itself -- action_requests paired by index with review_configs -- so
it is carried through verbatim. That removes the drift risk that made the
langgraph rung emit a shape the card's schema rejects, and it is why the
assertion below is about the part SURVIVING rather than about fields we chose.
"""

import json

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver

import main

# THIS FILE SURVIVES AN EJECT AND THE MODULE IT DRIVES DOES NOT (#588).
# A rung-1 or rung-2 fork prunes ai_backends/deepagents.py and keeps this file, so
# a module-level import would fail at COLLECTION and take the whole suite down --
# measured on the langgraph equivalent, which reported "Interrupted: 1 error
# during collection". The skip is because the SUBJECT is absent, not because the
# assertion was inconvenient.
da = pytest.importorskip(
    "ai_backends.deepagents",
    reason="the deepagents rung is not in this tree (it was ejected)",
)

from test_approval_withholds import ScriptedModel  # noqa: E402

# `get_counter` is read-only and therefore NOT gated; `increment` is.
POLICY = {"approvalPolicy": {"readOnlyTools": ["read_file", "get_counter"]}}
MESSAGES = [{"role": "user", "content": "hello"}]


@pytest.fixture
def client():
    return TestClient(main.app)


def _effects(monkeypatch, call_tool):
    """Script the model to call `call_tool`; count what each tool actually did.

    BOTH TOOLS RECORD. A test counting only `increment` cannot tell "the
    allowlisted call was not gated" from "it never happened" -- both leave that
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
    monkeypatch.setattr(da, "make_llm", lambda: model)
    monkeypatch.setattr(da, "TOOLS", [increment, get_counter])
    monkeypatch.setattr(da, "_graph", None)
    return counts


def _post(client, *, topology="react", policy=True, session=True):
    body = {"messages": MESSAGES, "topology": topology, "aiBackend": "deepagents"}
    if policy:
        body.update(POLICY)
    if session:
        body["sessionId"] = "sess-da"
    return client.post("/api/chat/stream/deepagents", json=body)


def _parts(text, kind):
    """Every AI SDK v6 part of `kind` on the wire, parsed.

    READS `data:` LINES AS PARTS, which is this rung's wire and not the other
    two's. A helper copied from the langgraph tests would look for
    `event: approval_pending` and find nothing here -- and "found nothing" is
    what a working gate and a dropped frame both look like.
    """
    out = []
    for line in text.split("\n"):
        if not line.startswith("data: "):
            continue
        try:
            part = json.loads(line[len("data: ") :])
        except json.JSONDecodeError:
            continue
        if isinstance(part, dict) and part.get("type") == kind:
            out.append(part)
    return out


def _proceeded(res):
    """200 AND no error frame. A 200 alone is set before the generator runs."""
    return res.status_code == 200 and "data-error" not in res.text


def test_the_SHIPPED_configuration_gates_react(client, monkeypatch):
    """NO monkeypatch of GATED_TOPOLOGIES — the one case that fails if this set is empty."""
    counts = _effects(monkeypatch, "increment")
    res = _post(client)
    assert _proceeded(res), res.text
    assert counts["increment"] == 0, (
        "the shipped configuration did not withhold the call; either react left "
        "deepagents' GATED_TOPOLOGIES or the gate is not wired to it"
    )
    assert _parts(res.text, "data-approval-pause"), (
        "the call was withheld and the client was told nothing — a 200 whose only "
        "distinguishing feature is an absence"
    )


def test_the_pause_is_an_AI_SDK_PART_not_an_SSE_event(client, monkeypatch):
    """The rung-specific claim, and the one an inherited test would not make.

    `deepagentsAdapter` converts nothing — it strips messageId from finish frames
    and passes the rest through. So the part must leave Python already in the
    shape ApprovalPauseSchema parses. An `event: approval_pending` frame here
    would withhold the tool correctly and reach no component, which is a green
    backend test over a silent client.
    """
    _effects(monkeypatch, "increment")
    text = _post(client).text
    assert "event: approval_pending" not in text, (
        "this rung emitted the langchain/langgraph SSE shape, which no adapter "
        "downstream of it converts"
    )
    parts = _parts(text, "data-approval-pause")
    assert len(parts) == 1, parts
    interrupt = parts[0]["data"]["interrupt"]
    # Carried verbatim from deepagents, not authored here — so this asserts the
    # crossing rather than fields we chose. These are what the card renders from.
    assert [r["name"] for r in interrupt["action_requests"]] == ["increment"], interrupt
    assert [c["action_name"] for c in interrupt["review_configs"]] == ["increment"], interrupt
    assert interrupt["review_configs"][0]["allowed_decisions"] == [
        "approve",
        "edit",
        "reject",
        "respond",
    ], interrupt


def test_an_ALLOWLISTED_tool_is_NOT_gated_and_RUNS(client, monkeypatch):
    """The per-tool case: the policy excuses read-only tools and the gate honours it."""
    counts = _effects(monkeypatch, "get_counter")
    res = _post(client)
    assert _proceeded(res), res.text
    assert counts["get_counter"] == 1, (
        "an allowlisted read-only tool did not run; the gate is coarser than the "
        "policy it claims to implement"
    )
    assert not _parts(res.text, "data-approval-pause"), (
        "an allowlisted tool produced an approval request, so a person is being "
        "asked to approve something the policy already excused"
    )


def test_the_ungated_control_DOES_run_the_tool(client, monkeypatch):
    """The companion a disarming mutation must leave GREEN."""
    counts = _effects(monkeypatch, "increment")
    monkeypatch.setattr(da, "GATED_TOPOLOGIES", frozenset())
    res = _post(client, policy=False, session=False)
    assert _proceeded(res), res.text
    assert counts["increment"] == 1, (
        "the tool did not run even with the gate off, so the withholding measured "
        "above is not evidence the gate did anything"
    )


def test_a_GATED_run_is_still_traced(client, monkeypatch):
    """The gated path calls langfuse_config(), asserted behaviourally.

    The langgraph rung shipped `config = thread if gated else langfuse_config()` —
    a ternary choosing between the two instead of merging them — and ran every
    gated turn untraced while /health reported the backend as traced.
    check-langfuse-wiring reads the SOURCE for the literal at the call site; this
    asserts the function was actually CALLED while the gate was active.
    """
    counts = _effects(monkeypatch, "increment")
    calls = []
    real = da.langfuse_config

    def counting():
        calls.append(1)
        return real()

    monkeypatch.setattr(da, "langfuse_config", counting)
    res = _post(client)
    assert _proceeded(res), res.text
    assert counts["increment"] == 0, "precondition: this run must be the gated one"
    assert calls, (
        "a gated run never called langfuse_config(), so it ran untraced while "
        "/health reports this backend as traced"
    )

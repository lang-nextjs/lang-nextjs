"""The langgraph rung gates react, and it gates it PER TOOL (#332 steps C2/C3).

WHY THIS FILE EXISTS SEPARATELY FROM test_approval_dispatch.py. That file drives the
langchain rung, whose gate is `HumanInTheLoopMiddleware`. This rung has no middleware
available -- `create_react_agent` takes no such argument -- so its gate is a different
mechanism reaching the same guarantee, and a mechanism gets its own witness or the
suite is asserting the declaration rather than the behaviour.

WHAT WAS MEASURED BEFORE ANY OF IT WAS WRITTEN, against langgraph 1.2.11:

    interrupt_before=["tools"]      0 effects at the pause, and ZERO interrupts on the
                                    state -- the graph stops without a payload, so the
                                    client gets a 200 and silence
    post_model_hook + interrupt()   0 effects at the pause, ONE interrupt carrying
                                    action_requests, and the effect runs on resume

#332's table names the first. It withholds correctly and reports nothing, which is the
defect that kept #413 disarmed, so this rung uses the second.

THE ALLOWLIST CASE IS THE ONE THAT SEPARATES THEM. `interrupt_before` pauses before the
tools node whatever tool was called, so a request whose policy excuses `get_counter`
would still pause on it while the langchain plane would not. That is two runtimes
answering the same policy differently -- and it is invisible to every test that only
ever calls a gated tool.
"""

import json

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver

import main

# THIS FILE SURVIVES AN EJECT AND THE MODULE IT DRIVES DOES NOT (#588).
#
# Measured, not anticipated: `node scripts/eject.mjs langchain` prunes
# ai_backends.langgraph and keeps this file, and a module-level
# `import ai_backends.langgraph` then fails at COLLECTION -- which does not
# fail one test, it takes the whole suite down with
# "Interrupted: 1 error during collection". 2 skipped, 1 error, nothing else ran.
#
# So the import is guarded, and the guard is honest about what it means: in a fork
# below this rung the backend genuinely is not there, so its behaviour cannot be
# observed and there is nothing here to be wrong about. It is a skip because the
# SUBJECT is absent, not because the assertion was inconvenient -- the distinction
# this repo keeps having to relearn.
lg = pytest.importorskip(
    "ai_backends.langgraph",
    reason="the langgraph rung is not in this tree (it was ejected)",
)
from test_approval_withholds import ScriptedModel

# `get_counter` is read-only and therefore NOT gated; `increment` is.
POLICY = {"approvalPolicy": {"readOnlyTools": ["read_file", "get_counter"]}}
MESSAGES = [{"role": "user", "content": "hello"}]


@pytest.fixture
def client():
    return TestClient(main.app)


def _effects(monkeypatch, call_tool):
    """Script the model to call `call_tool`, and count what each tool actually did.

    BOTH TOOLS RECORD, and that is deliberate. A test that only counts `increment`
    cannot tell "the allowlisted call was not gated" from "the allowlisted call never
    happened" -- both leave the increment counter at zero. The read counter is the
    presence companion.
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
    # The ungated singleton, for the same reason the langchain file resets `_graph`:
    # whichever test builds it first would fix the tool inventory for every test after,
    # making the suite green or red by ORDER rather than by behaviour.
    monkeypatch.setattr(lg, "_react_graph", None)
    return counts


def _post(client, *, topology="react", policy=True, session=True):
    body = {"messages": MESSAGES, "topology": topology, "aiBackend": "langgraph"}
    if policy:
        body.update(POLICY)
    if session:
        body["sessionId"] = "sess-lg"
    return client.post("/api/chat/stream/langgraph", json=body)


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


def _proceeded(res):
    """200 AND no error frame. A 200 alone is what let a NameError through once."""
    return res.status_code == 200 and "data-error" not in res.text


def test_the_SHIPPED_configuration_gates_react(client, monkeypatch):
    """NO monkeypatch of GATED_TOPOLOGIES, and that is the entire point.

    Every gating test written before #332 step B set the declaration itself first, so
    the suite supplied its own precondition and would have stayed green against an
    empty shipped set. This names "react" as a literal and reads the tree as it ships.
    """
    counts = _effects(monkeypatch, "increment")
    res = _post(client)
    assert _proceeded(res), res.text
    assert counts["increment"] == 0, (
        "the shipped configuration did not withhold the call; either react left "
        "langgraph's GATED_TOPOLOGIES or the gate is not wired to it"
    )
    assert _approval_frames(res.text), (
        "the call was withheld and the client was told nothing -- a 200 whose only "
        "distinguishing feature is an absence, which is what interrupt_before would "
        "have shipped"
    )


def test_an_ALLOWLISTED_tool_is_NOT_gated_and_RUNS(client, monkeypatch):
    """The policy is per-tool, and this is the case that proves the gate honours it.

    THE CONTROL FOR THE MECHANISM CHOICE, not for the gate. If this rung used
    `interrupt_before=["tools"]` every assertion here would fail: it would pause, emit
    no frame, and leave the read at zero. The langchain plane answers this same request
    by running the tool, so this is also what keeps the two runtimes agreeing about a
    policy rather than only about a declaration.
    """
    counts = _effects(monkeypatch, "get_counter")
    res = _post(client)
    assert _proceeded(res), res.text
    assert counts["get_counter"] == 1, (
        "an allowlisted read-only tool did not run; the gate is coarser than the "
        "policy it claims to implement"
    )
    assert not _approval_frames(res.text), (
        "an allowlisted tool produced an approval request, so a person is being asked "
        "to approve something the policy already excused"
    )


def test_the_ungated_control_DOES_run_the_tool(client, monkeypatch):
    """The companion. Without it, every assertion above is satisfied by a broken dispatch.

    Same request, same scripted model, react removed from the declaration: the tool
    runs. That is what separates "the gate withheld it" from "nothing works on this
    rung", and it is the case a disarming mutation must leave GREEN.
    """
    counts = _effects(monkeypatch, "increment")
    monkeypatch.setattr(lg, "GATED_TOPOLOGIES", frozenset())
    res = _post(client, policy=False, session=False)
    assert _proceeded(res), res.text
    assert counts["increment"] == 1, (
        "the tool did not run even with the gate off, so the withholding measured "
        "above is not evidence the gate did anything"
    )


def test_the_payload_carries_the_action_and_the_decisions(client, monkeypatch):
    """The shape is authored on this rung, so it is asserted rather than assumed.

    On the langchain rung the payload is upstream's own dict, passed through. There is
    no upstream payload here -- the middleware that builds one lives in langchain -- so
    this rung constructs it, and a constructed shape drifts from the one the client
    parses unless something compares them. The fields named here are the ones
    `parse_approval_decisions` and the proxy adapter actually read.
    """
    counts = _effects(monkeypatch, "increment")
    frames = _approval_frames(_post(client).text)
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

    from ai_backends._common import _DECISION_TYPES

    assert [c["action_name"] for c in payload["review_configs"]] == ["increment"], payload
    assert payload["review_configs"][0]["allowed_decisions"] == list(_DECISION_TYPES), payload
    assert len(payload["review_configs"]) == len(payload["action_requests"]), (
        "review_configs pairs with action_requests BY INDEX; a length mismatch "
        "silently offers one call's controls for another's"
    )


def test_a_GATED_run_is_still_traced(client, monkeypatch):
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
    res = _post(client)
    assert _proceeded(res), res.text
    assert counts["increment"] == 0, "precondition: this run must be the gated one"
    assert calls, (
        "a gated run never called langfuse_config(), so it ran untraced while "
        "/health reports this backend as traced"
    )

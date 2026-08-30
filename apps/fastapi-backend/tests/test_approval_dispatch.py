"""The refusal is reachable from a REQUEST, and the gated path is actually driven.

THE FIRST VERSION OF THIS FILE ASSERTED THE WRONG LAYER, and how it failed is worth more than
the bug it missed.

`guarded_stream` catches whatever a topology raises and turns it into a well-formed
`data-error` frame. The status line is already 200 by then, because headers go out before the
generator runs. So `assert res.status_code != 400` passed over a stream whose entire content
was a failure — and it did, twice over. `_common` was referenced as a module it had never been
imported as, so every gated request answered 200 carrying
`{"code": "backend_error", "message": "name '_common' is not defined"}`, and these tests
stayed green. A static undefined-name check caught what the suite could not.

The repair is not "assert that particular NameError is absent". It is to assert the BODY
rather than the envelope, which catches the next thing that fails inside the stream too.

AND THE MODEL IS SCRIPTED, because the second thing hiding behind the status code was an
Anthropic auth error: these tests were reaching a real model, failing, and reporting 200. A
test that needs a network call to mean anything is one that gets loosened until it passes.

    gated   + policy + sessionId   -> proceeds, gate active, TOOL DOES NOT RUN
    gated   + no policy            -> REFUSED, naming what to send
    gated   + no sessionId         -> REFUSED, naming the topology
    ungated + neither              -> UNCHANGED

The last is the scoping companion: without it the refusal is satisfied by refusing too much,
which would take `apps/example` down — it has no approval concept at all.
"""

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage
from langchain_core.tools import tool

import main
import ai_backends.langchain as lc
from ai_backends import _common
from test_approval_withholds import ScriptedModel

POLICY = {"approvalPolicy": {"readOnlyTools": ["read_file", "get_counter"]}}
MESSAGES = [{"role": "user", "content": "hello"}]


async def _trivial_stream(messages):
    yield 'data: {"type":"text-delta","delta":"ok"}\n\n'


class _UngatedModule:
    """A backend whose topology gates nothing and needs no model.

    The ungated companions used to run `plan-execute`, which reaches a real planner and a real
    model — so they asserted the scoping while exercising the network, and the network failure
    was invisible behind the status code. This isolates what they are actually about: a
    topology outside GATED_TOPOLOGIES is asked for neither a policy nor a sessionId.
    """

    TOPOLOGIES = {"plain": _trivial_stream}
    GATED_TOPOLOGIES = frozenset()


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setitem(main._MODULES, "ungated-probe", _UngatedModule)
    return TestClient(main.app)


@pytest.fixture
def effects(monkeypatch):
    """Script the model and the tool inventory so the gated path can be DRIVEN.

    Returns the side-effect counter. `make_llm` and `TOOLS` are patched on
    `ai_backends.langchain`, not on `_common`: that module imported the names, so rebinding
    them at the source would not change what its functions already hold.
    """
    counter = [0]

    @tool
    def increment() -> str:
        """Increment the counter by 1."""
        counter[0] += 1
        return f"Counter incremented to {counter[0]}"

    model = ScriptedModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[{"name": "increment", "args": {}, "id": "call-1"}],
            ),
            AIMessage(content="done"),
        ]
    )
    monkeypatch.setattr(lc, "make_llm", lambda: model)
    monkeypatch.setattr(lc, "TOOLS", [increment])
    return counter


def _post(client, *, path="langchain", topology, policy=True, session=True):
    body = {"messages": MESSAGES, "topology": topology, "aiBackend": path}
    if policy:
        body.update(POLICY)
    if session:
        body["sessionId"] = "sess-abc"
    return client.post(f"/api/chat/stream/{path}", json=body)


def _proceeded(res):
    """200 AND no error frame. A 200 alone is what let a NameError through."""
    return res.status_code == 200 and "data-error" not in res.text


# --------------------------------------------------------------------------- the gate itself


def test_a_gated_request_is_driven_and_the_tool_DOES_NOT_RUN(effects, client):
    """THE BEHAVIOURAL CLAIM, through the HTTP dispatch rather than a unit.

    Everything else here asserts a dispatch DECISION — refuse, proceed, unchanged. This one
    asserts what the gate is for: a request whose approval nobody answered has not executed
    its tool. The counter is the witness, as in #401.
    """
    res = _post(client, topology="react")
    assert _proceeded(res), res.text
    assert effects[0] == 0, (
        "the tool executed on a gated request that nobody approved — the gate reported a "
        "decision it never enforced, which is #256"
    )


def test_the_ungated_control_DOES_run_the_tool(effects, client, monkeypatch):
    """The presence companion for the gate itself.

    Without it, `effects == 0` above is equally consistent with a harness that never reaches
    the tool at all — and this file has already been fooled once by exactly that shape.
    """
    monkeypatch.setattr(lc, "GATED_TOPOLOGIES", frozenset())
    res = _post(client, topology="react", policy=False, session=False)
    assert _proceeded(res), res.text
    assert effects[0] == 1, (
        "ungated, the tool must run — a 0 here means the harness cannot observe execution "
        "and the 0 above proves nothing"
    )


# --------------------------------------------------------------------------- the refusals


def test_a_gated_request_with_no_policy_is_refused(client):
    res = _post(client, topology="react", policy=False)
    assert res.status_code == 400
    assert "readOnlyTools" in res.json()["detail"]


def test_a_gated_topology_with_no_sessionId_is_refused(client):
    """The refusal must NAME what is missing, in the shape parseRuntime uses."""
    res = _post(client, topology="react", session=False)
    assert res.status_code == 400
    detail = res.json()["detail"]
    assert "sessionId" in detail
    assert "react" in detail, "the refusal must name the topology that required it"


# --------------------------------------------------------------------------- the scoping


def test_an_UNGATED_topology_needs_neither_policy_nor_sessionId(client):
    """THE SCOPING COMPANION, and it protects a whole app.

    `apps/example` has no approval concept — no gate, no policy, no card. Requiring either of
    every caller would take it down to protect topologies that do not gate.
    """
    res = _post(
        client, path="ungated-probe", topology="plain", policy=False, session=False
    )
    assert _proceeded(res), res.text


def test_the_gated_set_is_declared_rather_than_inferred():
    """Read as a plain attribute, so a module that forgets it crashes rather than gating nothing."""
    from ai_backends import deepagents, langchain, langgraph

    assert langchain.GATED_TOPOLOGIES == frozenset({"react"})
    assert langgraph.GATED_TOPOLOGIES == frozenset()
    assert deepagents.GATED_TOPOLOGIES == frozenset()


# --------------------------------------------------------------------------- the coupling


def test_the_thread_id_is_derived_from_the_session_id_not_equal_to_it():
    """The seam where resume-ability and tracing would be decoupled."""
    assert _common.derive_thread_id("sess-abc") == "approval:sess-abc"
    assert _common.derive_thread_id("sess-abc") != "sess-abc"

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

import json

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver

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
    def increment(by: int = 1) -> str:
        """Increment the counter."""
        counter[0] += by
        return f"Counter incremented to {counter[0]}"

    model = ScriptedModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[{"name": "increment", "args": {"by": 1}, "id": "call-1"}],
            ),
            AIMessage(content="done"),
        ]
    )
    monkeypatch.setattr(lc, "make_llm", lambda: model)
    monkeypatch.setattr(lc, "TOOLS", [increment])
    # AND THE UNGATED SINGLETON IS RESET. `get_executor()` caches `_graph` for the process,
    # so whichever test builds it first fixes the tool inventory for every test after —
    # green or red by ORDER rather than by behaviour. Found by the ungated companion below
    # failing its own precondition: the tool did not run because the cached graph still held
    # the real TOOLS from an earlier test. The gated builder has no such problem; it is built
    # per request on purpose.
    monkeypatch.setattr(lc, "_graph", None)
    # AND A PRIVATE CHECKPOINTER PER TEST. `_APPROVAL_SAVER` is module-level on purpose —
    # resume needs the thread to survive between requests — but that also means every test
    # shares a thread namespace, and `sessionId` is the same string in all of them. One test
    # leaving a pending approval on `approval:sess-abc` would be resumed by the next.
    # Latent, not observed: each of these passes alone today. Reset anyway, because "passes
    # in isolation" and "passes in any order" are different properties and the `_graph` cache
    # already taught this file which one a suite quietly loses.
    monkeypatch.setattr(lc, "_APPROVAL_SAVER", InMemorySaver())
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


def test_a_gated_request_is_driven_and_the_tool_DOES_NOT_RUN(effects, client, monkeypatch):
    """THE BEHAVIOURAL CLAIM, through the HTTP dispatch rather than a unit.

    Everything else here asserts a dispatch DECISION — refuse, proceed, unchanged. This one
    asserts what the gate is for: a request whose approval nobody answered has not executed
    its tool. The counter is the witness, as in #401.

    IT ARMS THE GATE ITSELF rather than reading the shipped constant, and that is not
    incidental. `GATED_TOPOLOGIES` is empty today — the gate is built and deliberately not
    on, because a pause nobody can see is worse than the leak it fixes. A test that read the
    shipped value would have gone quietly vacuous the moment the switch went off: green,
    asserting nothing, exactly the shape this file was already fooled by once.
    """
    monkeypatch.setattr(lc, "GATED_TOPOLOGIES", frozenset({"react"}))
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


def test_a_gated_request_with_no_policy_is_refused(client, monkeypatch):
    monkeypatch.setattr(lc, "GATED_TOPOLOGIES", frozenset({"react"}))
    res = _post(client, topology="react", policy=False)
    assert res.status_code == 400
    assert "readOnlyTools" in res.json()["detail"]


def test_a_gated_topology_with_no_sessionId_is_refused(client, monkeypatch):
    """The refusal must NAME what is missing, in the shape parseRuntime uses."""
    monkeypatch.setattr(lc, "GATED_TOPOLOGIES", frozenset({"react"}))
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
    # PER-BACKEND, BECAUSE ONLY THIS TEST OF THE EIGHTEEN HERE NEEDS THE UPPER RUNGS (#565).
    # A module-level skip would take fifteen backend-agnostic tests with it, so the absent
    # rungs are skipped one at a time and the present ones are still ASSERTED — which keeps
    # the declaration checked in every fork that has the backend, rather than only in the
    # full tree.
    from ai_backends import langchain

    expected = {
        "langchain": frozenset({"react"}),
        "langgraph": frozenset({"react"}),
        "deepagents": frozenset({"react"}),
    }
    checked = []

    # ALL THREE RUNGS ARE ARMED FOR react, ON THIS PLANE, AND THIS SAYS SO RATHER THAN
    # ASSUMING IT. The switch should not move without a test saying so — that was the
    # point when everything was empty and it is the point now: langchain/react in #332
    # step B, langgraph/react in C2/C3, deepagents/react in C4/C5. `plan-execute` is
    # still off on every rung and `deep-research` on the one that has it — those are
    # positions, not omissions, and arming any of them means changing this literal,
    # deliberately, in the change that arms them.
    #
    # THIS TEST WENT RED WHEN C2 ARMED langgraph AND THAT IS THE MECHANISM WORKING.
    # It is the only thing in the repo that would have noticed the set moving; the
    # parity check compares the two planes with each other and would stay green if
    # both were armed by accident together.
    for name, want in expected.items():
        mod = pytest.importorskip(
            f"ai_backends.{name}",
            reason=f"backend {name} is not in this tree (its rung was ejected)",
        ) if name != "langchain" else langchain
        assert mod.GATED_TOPOLOGIES == want, name
        checked.append(name)
    # ANTI-VACUITY: skipping every backend would leave this asserting nothing at all.
    assert checked, "no backend was present, so the declaration was never read"


# --------------------------------------------------------------------------- the coupling


def test_the_thread_id_is_derived_from_the_session_id_not_equal_to_it():
    """The seam where resume-ability and tracing would be decoupled."""
    assert _common.derive_thread_id("sess-abc") == "approval:sess-abc"
    assert _common.derive_thread_id("sess-abc") != "sess-abc"

# --------------------------------------------------------------------------- surfacing


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


def _walk(obj):
    """Every value in a nested structure, regardless of where it sits."""
    yield obj
    if isinstance(obj, dict):
        for v in obj.values():
            yield from _walk(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk(v)


def test_a_withheld_call_is_SURFACED_to_the_client(effects, client, monkeypatch):
    """The pause must reach the person, or the gate is silence with extra steps.

    ASSERTED AS SURVIVAL, NOT AS LAYOUT. The frame's shape is provisional and #420 owns it,
    so this asserts that the tool name and all four decisions COME OUT THE OTHER SIDE —
    searched for anywhere in the payload — rather than that any field sits where it sits
    today. Pinning the layout now would make the provisional shape the contract by way of a
    test, which is the thing the marking at the emitter exists to prevent.
    """
    monkeypatch.setattr(lc, "GATED_TOPOLOGIES", frozenset({"react"}))
    res = _post(client, topology="react")
    assert _proceeded(res), res.text
    assert effects[0] == 0, "precondition: the call must have been withheld"

    frames = _approval_frames(res.text)
    assert frames, (
        "the call was withheld and the client was told nothing — 200, an empty message "
        "frame, and silence, which is an action whose outcome is not reported"
    )

    values = [v for f in frames for v in _walk(f)]
    assert "increment" in values, "the frame does not name the tool that was gated"

    decisions = {d for v in values if isinstance(v, list) for d in v if isinstance(d, str)}
    assert {"approve", "edit", "reject", "respond"} <= decisions, (
        f"the four-way vocabulary did not survive the crossing; got {sorted(decisions)}. "
        "Narrowing it here would decide #420 by accident."
    )


def test_the_SHIPPED_configuration_gates_react(effects, client):
    """THE SWITCH ITSELF, NOT THE MECHANISM (#332 step B2).

    NO monkeypatch, and that is the entire point of this case. Every other gating test in
    this file sets `GATED_TOPOLOGIES` to {"react"} first, so they prove the machinery works
    WHEN a topology is gated — they cannot see whether the shipped configuration gates
    anything, and they passed unchanged through the whole period when nothing did.

    Segments composing is a different claim from segments existing. The producer, the
    adapter, the schema, the card and the resume route each had a test; none of them had
    the path, because no test ever ran with the real set.

    NAMES THE TOPOLOGY RATHER THAN READING THE SET. Asking `GATED_TOPOLOGIES` what to
    expect would make this agree with whatever the set says — green when react is armed,
    green when it is removed, and an assertion that cannot disagree with its subject is
    not an assertion. Removing react from the set must turn this red.
    """
    res = _post(client, topology="react")
    assert _proceeded(res), res.text

    assert effects[0] == 0, (
        "the SHIPPED configuration ran the tool: react is not gated in the set this "
        "backend actually loads, whatever the mechanism tests say"
    )

    frames = _approval_frames(res.text)
    assert frames, (
        "react is gated and the run closed having emitted neither a tool result nor a "
        "pause — the person asked for something that mutates and received silence, which "
        "is the state #420 measured and the reason the set was empty until now"
    )
    values = [v for f in frames for v in _walk(f)]
    assert "increment" in values, "the surfaced pause does not name the tool it withheld"


def test_an_ungated_run_surfaces_NOTHING(effects, client, monkeypatch):
    """The companion — and it asserts the PROPERTY, not the guard, which is a real limit.

    It catches a frame emitted for a run that was never gated, which is what a person would
    experience. It does NOT catch the `if gated:` guard being removed: an ungated run uses
    `get_executor()`, which has no checkpointer, so `get_state()` raises and
    `_pending_approval_events` returns nothing whether or not the guard is there. Measured by
    mutation — made unconditional, all nine cases still pass.

    So the guard is belt-and-braces today and untested as such. It is kept rather than deleted
    because the property stops holding by accident the moment an ungated topology acquires a
    checkpointer for some unrelated reason, and then the frame would announce a pause nobody
    is waiting on. Written down because "the mutation did not fail" is only acceptable when
    the reason is known and stated.
    """
    monkeypatch.setattr(lc, "GATED_TOPOLOGIES", frozenset())
    res = _post(client, topology="react", policy=False, session=False)
    assert _proceeded(res), res.text
    assert effects[0] == 1, "precondition: ungated, the tool runs"
    assert not _approval_frames(res.text), (
        "an ungated run announced an approval nobody is waiting on"
    )

# --------------------------------------------------------------------------- resume


def _resume(client, decisions):
    body = {
        "messages": MESSAGES,
        "topology": "react",
        "aiBackend": "langchain",
        "sessionId": "sess-abc",
        "approvalDecisions": decisions,
        **POLICY,
    }
    return client.post("/api/chat/stream/langchain", json=body)


@pytest.fixture
def pending(effects, client, monkeypatch):
    """Leave a real pending approval on the thread, then hand back the counter."""
    monkeypatch.setattr(lc, "GATED_TOPOLOGIES", frozenset({"react"}))
    res = _post(client, topology="react")
    assert _proceeded(res), res.text
    assert effects[0] == 0, "precondition: the call must be pending, not executed"
    return effects


def test_approve_lets_the_call_through(pending, client):
    """The decision arrives on a LATER request and the tool finally runs.

    This is what makes the gate a gate rather than a block: #401 proved withholding in
    process, this proves the release survives the round trip to a new HTTP request that
    finds the same thread by its derived id.
    """
    res = _resume(client, [{"type": "approve"}])
    assert _proceeded(res), res.text
    assert pending[0] == 1, "an approved call never ran — a gate that cannot release is an outage"


def test_reject_leaves_it_unexecuted(pending, client):
    """0 IS ALSO WHAT A BROKEN RESUME PRODUCES, and that is worth stating.

    If the resume were ignored entirely this would still pass — the tool stays unexecuted
    either way. The discrimination lives in `approve` and `edit`, which both go red when the
    Command is dropped. This case is here for the decision's own semantics, not as a witness
    that resume works.
    """
    res = _resume(client, [{"type": "reject", "message": "no"}])
    assert _proceeded(res), res.text
    assert pending[0] == 0, "a rejected call executed anyway"


def test_respond_answers_ON_BEHALF_of_the_tool_without_running_it(pending, client):
    """`respond` is NOT a rejection, which is the whole reason the vocabulary is four-way.

    Upstream returns a ToolMessage with status="success" carrying the human's text as the
    tool's RESULT. Collapsing it to `approved: false` would tell the model the user refused
    when the user answered — a false statement about what happened, not a lossy one.
    """
    res = _resume(client, [{"type": "respond", "message": "it is 41"}])
    assert _proceeded(res), res.text
    # Same caveat as reject: 0 is also what an ignored resume yields. Recorded so the
    # coverage is not read as stronger than it is.
    assert pending[0] == 0, "respond must not execute the tool"


def test_edit_runs_the_tool_with_DIFFERENT_arguments(pending, client):
    """The decision binary-plus-a-string cannot express at all.

    `approved` has no truthful value here: this is neither "run as called" nor "do not run".
    The counter moving by 5 rather than 1 is the witness that the EDITED args reached the
    tool, not merely that something ran.
    """
    res = _resume(
        client,
        [{"type": "edit", "edited_action": {"name": "increment", "args": {"by": 5}}}],
    )
    assert _proceeded(res), res.text
    assert pending[0] == 5, (
        f"edited args did not reach the tool (counter={pending[0]}); 1 would mean the "
        f"original call ran and the edit was dropped"
    )


def test_an_unknown_decision_type_is_REFUSED(pending, client):
    """Not treated as a rejection. Guessing here is choosing whether the tool runs."""
    res = _resume(client, [{"type": "maybe"}])
    assert res.status_code == 400
    assert "maybe" in res.json()["detail"]
    assert pending[0] == 0


def test_a_malformed_edit_is_REFUSED(pending, client):
    res = _resume(client, [{"type": "edit"}])
    assert res.status_code == 400
    assert "edited_action" in res.json()["detail"]


def test_an_ordinary_turn_carries_no_decisions_and_is_not_refused(effects, client, monkeypatch):
    """The companion for the one place absent does NOT refuse.

    Every normal message arrives without decisions; refusing them would be the broad outage
    the scoping avoids, one field over.
    """
    monkeypatch.setattr(lc, "GATED_TOPOLOGIES", frozenset({"react"}))
    res = _post(client, topology="react")
    assert _proceeded(res), res.text


def test_a_decision_for_a_LOST_thread_is_REFUSED_not_swallowed(
    pending, client, monkeypatch
):
    """A click that cannot land must say so — it must not report success (#399).

    THE LOSS IS REAL, NOT MOCKED. `_APPROVAL_SAVER` is a module-level
    `InMemorySaver`, so replacing it is exactly what one restart or a second
    uvicorn worker does to a pending approval: the thread id the client resumes
    still resolves, and nothing is holding it.

    WHAT THIS REPLACES, measured on #399 before the fix. Resuming a lost thread
    does not raise and does not re-pause. The graph runs a full chain, executes
    nothing, and emits ZERO approval_pending frames — a clean 200 whose only
    distinguishing feature is the absence of tool frames, which is what an
    ordinary un-tooled turn also looks like. The operator was told their decision
    succeeded and nothing had happened.

    BOTH COMPANIONS ARE ALREADY IN THIS FILE, and this assertion is worth nothing
    without them:

      test_approve_lets_the_call_through          a LIVE thread must still
                                                  proceed and run the tool. Make
                                                  the liveness reader return
                                                  False always and that goes red
                                                  — so this 409 is not simply
                                                  refusing every decision.
      test_a_gated_request_is_driven_...          an ordinary turn carries no
                                                  decisions and is not judged, so
                                                  the refusal cannot fire on a
                                                  first message. A lost thread and
                                                  a never-run one hold zero
                                                  interrupts alike; only
                                                  "decisions were sent" separates
                                                  them.
    """
    monkeypatch.setattr(lc, "_APPROVAL_SAVER", InMemorySaver())

    res = _resume(client, [{"type": "approve"}])

    assert res.status_code == 409, (
        f"a decision for a lost thread answered {res.status_code} — the click "
        f"reported an outcome it did not have: {res.text[:200]}"
    )
    detail = res.json()["detail"]
    assert "no longer awaiting a decision" in detail, detail
    # WHY IT MUST NOT BE A 5xx: the client maps 404/409 to `unresolvable` and
    # disables the buttons. A retryable status would leave an operator clicking a
    # control that can never work.
    assert "restart" in detail, (
        "the refusal must say WHY, or the operator reads it as a bug and retries"
    )
    assert pending[0] == 0, (
        "the tool ran while the dispatch was refusing the decision that would "
        "have released it"
    )

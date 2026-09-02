"""The django plane's gate, asserted through its own dispatch (#332 step C1).

WHY THIS FILE EXISTS AT ALL, given fastapi has an equivalent. `check-run-axes-parity`
holds that both planes' `stream_chat_react`, `guarded_stream` and `_error_code` are
BYTE-IDENTICAL, so the code is known to agree. That is not the same claim as the
behaviour agreeing: identical code reading a different `GATED_TOPOLOGIES` is precisely
the asymmetry parity is designed not to object to, and until this file the django plane
had never been observed withholding anything.

THE ASSERTION THAT MATTERS TAKES NO monkeypatch. Every gating test on the fastapi plane
sets `GATED_TOPOLOGIES` to {"react"} before posting, so all of them prove the machinery
works WHEN a topology is gated — and every one of them passed unchanged through the whole
period when the shipped configuration gated nothing. They supplied their own precondition
and could not notice its absence. `test_the_SHIPPED_configuration_gates_react` below is
the one case here that would fail if this plane's set were empty.
"""

import asyncio
import json

import pytest
from django.test import AsyncClient
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver

from deepagents_backend.ai_backends import langchain as lc

MESSAGES = [{"role": "user", "content": "increment it by 1"}]
POLICY = {"approvalPolicy": {"readOnlyTools": ["read_file", "get_counter"]}}


class ScriptedModel(FakeMessagesListChatModel):
    """A fake chat model that accepts `bind_tools`.

    `FakeMessagesListChatModel` raises NotImplementedError from `bind_tools`, and every
    agent binds its tools before the first turn — so the plain fake fails before the
    question this file asks is reached.
    """

    def bind_tools(self, tools, **kwargs):  # noqa: ARG002
        return self


@pytest.fixture
def effects(monkeypatch):
    """Script the model and the tool inventory so the gated path can be DRIVEN.

    Patched on `ai_backends.langchain` rather than on `_common`: that module imported the
    names, so rebinding at the source would not change what its functions already hold.
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
    # `get_executor()` caches `_graph` for the process, so whichever test builds it first
    # would fix the tool inventory for every test after — green or red by ORDER rather
    # than by behaviour. The fastapi plane found this the hard way; inherited here rather
    # than rediscovered.
    monkeypatch.setattr(lc, "_graph", None)
    return counter


def _post(*, topology, policy=True, session=True):
    body = {"messages": MESSAGES, "topology": topology, "aiBackend": "langchain"}
    if policy:
        body.update(POLICY)
    if session:
        body["sessionId"] = "sess-django"

    async def go():
        client = AsyncClient()
        res = await client.post(
            "/api/chat/stream/langchain/",
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


def _walk(obj):
    """Every value in a nested structure, regardless of where it sits."""
    yield obj
    if isinstance(obj, dict):
        for v in obj.values():
            yield from _walk(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk(v)


def test_the_SHIPPED_configuration_gates_react(effects):
    """THE SWITCH ON THIS PLANE, NOT THE MECHANISM.

    NO monkeypatch of GATED_TOPOLOGIES. This posts react through django's own dispatch
    and asserts the tool did not run and a pause naming it came back. It is the first
    thing in this plane that would fail if the set were empty.

    NAMES THE TOPOLOGY RATHER THAN READING THE SET. Asking `GATED_TOPOLOGIES` what to
    expect would make it agree with whatever the set says — green when react is armed,
    green when it is removed — and an assertion that cannot disagree with its subject is
    not an assertion.
    """
    res, body = _post(topology="react")
    assert res.status_code == 200, body
    assert "data-error" not in body, body

    assert effects[0] == 0, (
        "the SHIPPED configuration ran the tool: react is not gated in the set THIS "
        "plane actually loads, whatever the fastapi plane's tests say"
    )

    frames = _approval_frames(body)
    assert frames, (
        "react is gated on this plane and the run closed having emitted neither a tool "
        "result nor a pause — the person asked for something that mutates and received "
        "silence, which is the state #420 measured"
    )
    values = [v for f in frames for v in _walk(f)]
    assert "increment" in values, "the surfaced pause does not name the tool it withheld"


def test_an_UNGATED_topology_on_this_plane_still_runs(effects):
    """The presence companion. Without it, the case above is satisfied by a plane that
    pauses everything — which would be a far worse regression than the one being fixed.

    `plan-execute` is not in GATED_TOPOLOGIES, so it must run to completion untouched.
    """
    res, body = _post(topology="plan-execute", policy=False, session=False)
    assert res.status_code == 200, body
    assert not _approval_frames(body), (
        "an ungated topology surfaced an approval pause — the gate is not scoped to the "
        "set, and every caller now meets a control they never asked for"
    )


def test_the_gated_set_is_declared_rather_than_inferred():
    """The tripwire for THIS plane, mirroring fastapi's.

    react is armed on all three rungs (#332 C1, C2/C3, C4/C5). `plan-execute` is not,
    on any rung, and neither is `deep-research`. Arming any of them
    means changing this test, deliberately, in the change that arms them.

    ASSERTS THE MODULES THAT ARE PRESENT RATHER THAN NAMING THEM ALL. The first draft
    did `from ... import deepagents, langgraph` at the top of the function, and that
    fails to IMPORT in a rung-2 fork where deepagents is pruned — a check living in a
    file the eject keeps, naming files the eject removes. Measured: it turned the
    ejected fork's suite red on an ImportError, which is this repo's #492 class
    reproduced inside a test written by someone who had just fixed it elsewhere.

    langchain is asserted unconditionally because it is rung 1 and survives every eject,
    so this can never degrade into a test that examines nothing.
    """
    import importlib

    assert lc.GATED_TOPOLOGIES == frozenset({"react"}), (
        "langchain/react is armed on this plane (#332 C1) and this is where that is "
        "declared; the switch should not move without this test saying so"
    )

    # PER-MODULE EXPECTATIONS, NOT ONE SET FOR ALL OF THEM. While every upper rung was
    # empty, one shared `frozenset()` read as economical; the moment one of them was
    # armed it would have had to become this anyway, and a loop asserting the same
    # value everywhere cannot express a tree where the rungs differ — which is the only
    # tree #332 ever produces between steps.
    expected = {
        "langgraph": frozenset({"react"}),
        "deepagents": frozenset({"react"}),
    }
    for name, want in expected.items():
        try:
            mod = importlib.import_module(f"deepagents_backend.ai_backends.{name}")
        except ImportError:
            # Pruned by an eject. Not a skipped assertion — the module is genuinely
            # absent from this tree, so there is no set here to be wrong about.
            continue
        assert mod.GATED_TOPOLOGIES == want, (
            f"{name}'s gated set on this plane is not what #332 declared; the switch "
            f"should not move without this test saying so"
        )


# --------------------------------------------------------------------------- resume


def _resume(decisions):
    """Post the SAME turn again, carrying decisions for the pending approval.

    A SECOND HTTP REQUEST, NOT A CONTINUATION OF THE FIRST. `_post` builds a fresh
    `AsyncClient` per call and the first request's response has already been drained,
    so nothing in-process links the two. The thread is found again from `sessionId`
    via its derived id, and the pending interrupt is read back out of
    `_APPROVAL_SAVER`. That round trip is the thing under test: #401 established that
    the call is withheld IN process, which a gate that never releases also achieves.
    """
    body = {
        "messages": MESSAGES,
        "topology": "react",
        "aiBackend": "langchain",
        "sessionId": "sess-django",
        "approvalDecisions": decisions,
        **POLICY,
    }

    async def go():
        client = AsyncClient()
        res = await client.post(
            "/api/chat/stream/langchain/",
            data=json.dumps(body),
            content_type="application/json",
        )
        # A REFUSAL IS A JsonResponse, NOT A STREAM, and reading it as one turns a
        # meaningful rejection into `AttributeError: no attribute streaming_content`.
        # That is a crash where a diagnosis belongs: the run really did fail, but the
        # message names this helper instead of naming the route's answer. Measured by
        # dropping the thread between the pause and the resume — django REFUSES that
        # rather than swallowing it, and the first version of this helper reported the
        # refusal as a bug in itself.
        if not hasattr(res, "streaming_content"):
            return res, res.content.decode()
        chunks = []
        async for chunk in res.streaming_content:
            chunks.append(chunk.decode() if isinstance(chunk, bytes) else str(chunk))
        return res, "".join(chunks)

    return asyncio.run(go())


@pytest.fixture
def pending(effects):
    """Leave a real pending approval on the thread, then hand back the counter.

    NO monkeypatch OF `GATED_TOPOLOGIES`, deliberately, and this is where this file
    differs from fastapi's equivalent rather than copying it. Every gating test on that
    plane arms the set itself before posting, so all of them prove the machinery works
    WHEN something is gated — and all of them passed unchanged through the period when
    the shipped configuration gated nothing. Supplying your own precondition means you
    cannot notice its absence.

    So this posts react through the shipped configuration. If that set were emptied the
    tool would run here and the precondition below fails by name, which is the correct
    and loud outcome rather than a resume test quietly passing over a gate that was
    never closed.
    """
    # THE INVENTORY THIS TEST NEEDS, ASSERTED RATHER THAN INHERITED. `get_executor()`
    # caches `_graph` for the process, so whichever test builds it first fixes the tool
    # set for every test after. A run that passes because it happened to go second is
    # reporting a verdict it never computed. These two lines cost nothing and make the
    # precondition observable instead of positional.
    # NOT `assert lc._graph is None`. That was the obvious guard and it is VACUOUS here:
    # measured, `_graph` is None before the ungated post, after it, and after a gated one,
    # so the assertion cannot fail and would report a verdict it never computed. The
    # inventory is the thing that actually decides whether the counter these tests read is
    # the one the tool moves, and removing the `TOOLS` patch does turn this red naming the
    # real set, so this is the half that discriminates.
    assert [t.name for t in lc.TOOLS] == ["increment"], (
        f"the scripted inventory is not in place (got {[t.name for t in lc.TOOLS]}); "
        f"the counter these tests read would not be the one the tool moves"
    )

    res, body = _post(topology="react")
    assert res.status_code == 200, body
    assert effects[0] == 0, (
        "precondition: the call must be PENDING, not executed — react is not gated in "
        "the set this plane actually loads, so there is no approval here to resume"
    )
    assert _approval_frames(body), (
        "precondition: the gate withheld the call but announced nothing, so no client "
        "could ever produce the decision these tests go on to send"
    )
    return effects


def test_approve_lets_the_call_through(pending):
    """THE ASSERTION THIS FILE WAS MISSING: a decision is HONOURED, not merely accepted.

    `effects == 0` — everything this plane asserted before now — is satisfied by a
    working gate AND by a gate that will never release anything. The two are
    indistinguishable in that number. A saverless or otherwise broken resume returns
    200, re-emits a well-formed pause, and leaves the counter at 0 exactly as a correct
    withhold does, so nothing already here could tell them apart.

    1 is the value only a released call produces.
    """
    res, body = _resume([{"type": "approve"}])
    assert res.status_code == 200, body
    assert pending[0] == 1, (
        f"an approved call never ran (counter={pending[0]}) — the decision crossed a new "
        f"HTTP request and did not reach the thread; a gate that cannot release is an "
        f"outage that every effects==0 assertion on this plane reads as healthy"
    )


def test_edit_runs_the_tool_with_DIFFERENT_arguments(pending):
    """The decision a boolean-plus-a-string cannot express at all.

    `approved` has no truthful value here: this is neither "run as called" nor "do not
    run". The counter moving by 5 rather than 1 is what witnesses that the EDITED args
    reached the tool — 1 would mean the original call ran and the edit was silently
    dropped, which is the failure that looks most like success.
    """
    res, body = _resume(
        [{"type": "edit", "edited_action": {"name": "increment", "args": {"by": 5}}}]
    )
    assert res.status_code == 200, body
    assert pending[0] == 5, (
        f"edited args did not reach the tool (counter={pending[0]}); 1 means the "
        f"original call ran and the edit was dropped, 0 means nothing ran at all"
    )


def test_reject_leaves_it_unexecuted(pending):
    """0 IS ALSO WHAT A BROKEN RESUME PRODUCES, and that is worth stating in the file.

    If the decision were ignored entirely this would still pass — the tool stays
    unexecuted either way. The discrimination lives in `approve` and `edit` above, which
    both go red when the resume is dropped. This case is here for the decision's own
    semantics, not as a witness that resume works, and reading it as the latter would
    overstate what this plane covers.
    """
    res, body = _resume([{"type": "reject", "message": "no"}])
    assert res.status_code == 200, body
    assert pending[0] == 0, "a rejected call executed anyway"


def test_respond_answers_ON_BEHALF_of_the_tool_without_running_it(pending):
    """`respond` is NOT a rejection, which is the whole reason the vocabulary is four-way.

    Upstream returns a ToolMessage with status="success" carrying the human's text as the
    tool's RESULT. Collapsing it into a denial would tell the model the user REFUSED when
    the user ANSWERED on the tool's behalf — false about what happened, not merely lossy.

    Same caveat as reject: 0 is also what an ignored resume yields, recorded here so this
    is not read as stronger evidence than it is.
    """
    res, body = _resume([{"type": "respond", "message": "it is 41"}])
    assert res.status_code == 200, body
    assert pending[0] == 0, "respond must not execute the tool"


def test_reposting_WITHOUT_a_decision_does_not_release_the_call(pending):
    """THE CONTROL FOR THE TWO ABOVE: it is the DECISION that releases, not the retry.

    `test_approve` asserts the counter reaches 1 after a second request. On its own that
    is also consistent with a route where merely re-sending the turn runs the tool — in
    which case the approval would be decorative and the assertion would be measuring the
    retry. Sending the same turn with no decisions must leave it exactly where it was.

    Measured, not assumed: dropping `approvalDecisions` from `_resume` turns `approve`
    and `edit` red at counter=0 while `reject` and `respond` stay green, which is the
    same asymmetry their docstrings claim and the reason those two are not evidence.
    """
    # THE TURN AGAIN WITH NO `approvalDecisions` KEY AT ALL, which is what a retry
    # actually looks like. Sending `[]` instead tests something else entirely: the route
    # refuses an empty list by name ("must be a non-empty list"), so that version would
    # have gone red on the route's input validation and never reached the question.
    res, body = _post(topology="react")
    assert res.status_code == 200, body
    assert pending[0] == 0, (
        f"re-posting the turn ran the tool without any decision (counter={pending[0]}) — "
        f"the approval is not what gates execution, so approving proves nothing"
    )


# ------------------------------------------------------------------- refusals

# WHY THESE ARE ASSERTED ON THIS PLANE TOO, when `check-run-axes-parity` already holds
# the shared dispatch byte-identical. The parse that REJECTS a decision lives in
# `_common.py` and is compared. The turning of that rejection into an HTTP response does
# not: it is `views.py` here and `main.py` on the other plane, one Django and one FastAPI,
# and parity cannot compare them. Measured the hard way — `_resume` originally assumed a
# streaming response, and django's refusal surfaced as `AttributeError: no attribute
# streaming_content` because a refusal here is a JsonResponse. That is plane-specific
# behaviour breaking a test on the day the argument "byte-identical code makes this
# redundant" was nearly used to skip writing it.
#
# So these assert THIS ROUTE'S OWN STATUS AND WORDS, not a shape shared with fastapi,
# whose refusals carry `detail` rather than `error`.


def test_an_unknown_decision_type_is_REFUSED(pending):
    """Not treated as a rejection. Guessing here is choosing whether the tool runs.

    A route that silently mapped an unrecognised decision onto "reject" would look
    correct from the outside — nothing runs, which is what reject does — while having
    decided something the caller never asked for.
    """
    res, body = _resume([{"type": "maybe"}])
    assert res.status_code == 400, body
    payload = json.loads(body)
    assert "maybe" in payload["error"], (
        f"the refusal does not name the value it refused: {payload['error']}"
    )
    for decision in ("approve", "edit", "reject", "respond"):
        assert decision in payload["error"], (
            f"the refusal does not name '{decision}' among the accepted set, so a caller "
            f"who sent a typo has to guess what was expected: {payload['error']}"
        )
    assert pending[0] == 0, "a refused decision executed the tool anyway"


def test_a_malformed_edit_is_REFUSED(pending):
    """An `edit` with no `edited_action` is the shape most likely to be sent by accident.

    Falling back to approve would run the ORIGINAL arguments — the exact call the user
    was in the middle of changing when they got the payload wrong.
    """
    res, body = _resume([{"type": "edit"}])
    assert res.status_code == 400, body
    payload = json.loads(body)
    assert "edited_action" in payload["error"], (
        f"the refusal does not name the missing field: {payload['error']}"
    )
    assert pending[0] == 0, "a malformed edit ran the tool with its original arguments"


def test_a_decision_for_a_LOST_thread_is_REFUSED_with_409_not_400(pending):
    """A click that cannot land must say so, and must say WHICH kind of no it is (#399).

    THE LOSS IS REAL, NOT MOCKED. `_APPROVAL_SAVER` is module-level, so replacing it is
    exactly what one restart or a second worker does to a pending approval: the derived
    thread id still resolves and nothing is holding it.

    409 RATHER THAN 400 IS THE ASSERTION THAT DOES WORK HERE. Both are refusals, and a
    route that collapsed this into 400 would still decline the request and would still
    look correct to anyone testing only that bad input is refused. The status is the only
    evidence that the route distinguishes "your request is malformed" from "your request
    was fine and the thing it referred to is gone" — which are different instructions to
    the caller: fix the payload, versus send the turn again.

    This is also the fail-open case one layer down. ARCHITECT measured a saverless
    `create_agent` re-pausing silently with a fresh id and a byte-identical payload, so
    the middleware alone cannot tell the operator their decision was discarded. Through
    this route it can, and that protection does not come from the middleware.
    """
    lc._APPROVAL_SAVER = InMemorySaver()
    res, body = _resume([{"type": "approve"}])
    assert res.status_code == 409, (
        f"a decision for a vanished thread returned {res.status_code}, not 409 — the "
        f"caller cannot tell a lost approval from a bad payload: {body}"
    )
    payload = json.loads(body)
    assert "no longer awaiting a decision" in payload["error"], (
        f"the refusal does not explain that the approval is gone: {payload['error']}"
    )
    assert pending[0] == 0, (
        "the tool ran on a thread that was supposed to be lost, which means the "
        "precondition never held and this test proves nothing"
    )

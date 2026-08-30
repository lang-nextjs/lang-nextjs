"""The refusal is reachable from a REQUEST, and it is scoped to gated topologies.

The policy parser had unit tests and no caller: a property asserted and not deployed. These
drive the dispatch, so what is measured is what a client actually gets.

THREE CASES, AND THE THIRD IS WHY THERE ARE THREE.

    gated   + sessionId    -> proceeds, gate active
    gated   + no sessionId -> REFUSED, naming what is missing
    ungated + no sessionId -> UNCHANGED, still works

Without the third, "it refuses when sessionId is missing" is satisfied by refusing every
request that omits one — a far larger contract break than the gate needs, and a broad outage
sold as a safety fix. The ungated case is the presence companion for the scoping, exactly as
the well-formed policy is the presence companion for the parser.
"""

import pytest
from fastapi.testclient import TestClient

from main import app
from ai_backends import _common

POLICY = {"approvalPolicy": {"readOnlyTools": ["read_file", "get_counter"]}}
MESSAGES = [{"role": "user", "content": "hello"}]


@pytest.fixture
def client():
    return TestClient(app)


def _post(client, *, topology, policy=True, session=True):
    body = {"messages": MESSAGES, "topology": topology, "aiBackend": "langchain"}
    if policy:
        body.update(POLICY)
    if session:
        body["sessionId"] = "sess-abc"
    return client.post("/api/chat/stream/langchain", json=body)


# --------------------------------------------------------------------------- the policy


def test_a_request_with_no_policy_is_refused(client):
    """The refusal that was previously only reachable from a unit test."""
    res = _post(client, topology="react", policy=False)
    assert res.status_code == 400
    assert "readOnlyTools" in res.json()["detail"]


def test_a_request_with_a_policy_is_not_refused_for_that_reason(client):
    """Presence companion. A dispatch that 400s everything would pass the test above."""
    res = _post(client, topology="react")
    assert res.status_code != 400, res.text


def test_an_UNGATED_topology_with_no_policy_still_works(client):
    """THE SCOPING COMPANION FOR THE POLICY, and it protects a whole app.

    apps/example has no approval concept at all — no gate, no policy, no card. Requiring a
    policy of every caller would have taken it down to protect topologies that do not gate,
    which is the same "broad outage sold as a safety fix" the sessionId scoping avoids.

    A caller whose topology starts gating later has to send one then, and will be told so by
    name rather than silently running ungated.
    """
    res = _post(client, topology="plan-execute", policy=False, session=False)
    assert res.status_code != 400, res.text


# --------------------------------------------------------------------------- the thread


def test_a_gated_topology_with_no_sessionId_is_refused(client):
    """A gate with no thread pauses a call nobody can ever answer.

    That is not merely similar to #399 — it manufactures new instances of it while that fix
    is being written. The refusal must NAME what is missing, in the shape parseRuntime uses:
    a bare 400 is a wall.
    """
    res = _post(client, topology="react", session=False)
    assert res.status_code == 400
    detail = res.json()["detail"]
    assert "sessionId" in detail
    assert "react" in detail, "the refusal must name the topology that required it"


def test_an_UNGATED_topology_with_no_sessionId_still_works(client):
    """THE SCOPING COMPANION, and the reason the refusal is not simply global.

    plan-execute is not in langchain's GATED_TOPOLOGIES, so it has no thread to resume on and
    needs none. If this ever starts failing, the refusal has grown past the gate it was
    written for and is breaking callers that were never asked to change.
    """
    res = _post(client, topology="plan-execute", session=False)
    assert res.status_code != 400, res.text


def test_the_gated_set_is_declared_rather_than_inferred():
    """`GATED_TOPOLOGIES` is read as a plain attribute by the dispatch.

    Pinned because a module that forgets it should crash on the first request rather than
    quietly gate nothing — which is what `getattr(module, ..., frozenset())` would do.
    """
    from ai_backends import deepagents, langchain, langgraph

    assert langchain.GATED_TOPOLOGIES == frozenset({"react"})
    # Stated, not assumed: these are ungated TODAY and the assertion records which.
    assert langgraph.GATED_TOPOLOGIES == frozenset()
    assert deepagents.GATED_TOPOLOGIES == frozenset()


# --------------------------------------------------------------------------- the coupling


def test_the_thread_id_is_derived_from_the_session_id_not_equal_to_it():
    """The seam. Resume-ability now depends on an id that exists for TRACING.

    Deriving rather than using it directly costs nothing and is where the two would be
    decoupled if tracing ever changes how it mints ids — which would otherwise break approval
    resume silently, with nothing connecting the two.
    """
    assert _common.derive_thread_id("sess-abc") == "approval:sess-abc"
    assert _common.derive_thread_id("sess-abc") != "sess-abc"

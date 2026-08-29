"""A conversation's turns group, because the session is real now (#171).

The session identity was broken in three places at once, and every one of them
looked correct on its own:

    client   sessionId: "lang-nextjs-chat"   a constant — same value for every
                                             user, browser and conversation
    route    const { sessionId: _sid, ... }  destructured out, never forwarded
    here     set_run_axes(... no session)    nothing to record

So `langfuse_session_id` was never set, and a conversation's turns arrived in
Langfuse as unrelated traces. The field existed at every layer and carried
nothing end to end.

WHY THE ABSENT CASE MATTERS AS MUCH AS THE PRESENT ONE. An absent session and a
session whose value is the string "None" are different facts, and only one of
them is true. A trace grouped under "None" looks grouped — it would collect
every request from every client that failed to send one, which is worse than
being ungrouped because it reads as a working feature.
"""

import pytest

from ai_backends import _common


@pytest.fixture(autouse=True)
def _clear_axes():
    _common.set_run_axes()
    yield
    _common.set_run_axes()


def test_a_session_becomes_langfuse_session_id():
    _common.set_run_axes(
        runtime="fastapi", framework="deepagents", topology="react",
        session="conv-abc-123",
    )
    md = _common.langfuse_trace_metadata()
    assert md.get("langfuse_session_id") == "conv-abc-123"


def test_the_session_is_an_identity_not_a_tag():
    """It is pulled out rather than tagged. `session:conv-abc` as a tag would
    make every conversation its own tag value, which is a filter with one member
    each — the opposite of what tags are for."""
    _common.set_run_axes(
        runtime="fastapi", framework="deepagents", topology="react",
        session="conv-abc-123",
    )
    md = _common.langfuse_trace_metadata()
    assert not any("session" in t for t in md["langfuse_tags"]), md["langfuse_tags"]
    assert sorted(md["langfuse_tags"]) == [
        "framework:deepagents",
        "runtime:fastapi",
        "topology:react",
    ]


def test_no_session_means_NO_KEY_not_an_empty_one():
    _common.set_run_axes(runtime="fastapi", framework="deepagents", topology="react")
    md = _common.langfuse_trace_metadata()
    assert "langfuse_session_id" not in md, md


@pytest.mark.parametrize("falsey", ["", None])
def test_a_falsey_session_is_absent_not_recorded(falsey):
    """An older client that sends `sessionId: ""` must not group every one of
    its conversations together under the empty string."""
    _common.set_run_axes(
        runtime="fastapi", framework="deepagents", topology="react", session=falsey
    )
    md = _common.langfuse_trace_metadata()
    assert "langfuse_session_id" not in md, md


def test_two_conversations_are_distinguishable():
    """The property the whole chain exists to deliver. Against the old constant
    this assertion could not have failed, because both calls returned the same
    string — which is what made a check on the session identity theatre."""
    seen = []
    for conv in ("conv-one", "conv-two"):
        _common.set_run_axes(
            runtime="fastapi", framework="deepagents", topology="react", session=conv
        )
        seen.append(_common.langfuse_trace_metadata()["langfuse_session_id"])
    assert seen == ["conv-one", "conv-two"]

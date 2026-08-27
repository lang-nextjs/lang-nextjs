"""Which run a trace belongs to, as something you can filter on.

A trace arrived named `fastapi-deepagents-react`, so the runtime, framework and
topology were all present — baked into one opaque string, with `tags: []`
beside it. Finding every langgraph run meant substring-matching a name, and
comparing two frameworks' cost meant doing that twice by hand.

These pin the tags and the reasons the shape is what it is:

  * `axis:value`, so Langfuse's tag filter cuts BOTH ways — `framework:langgraph`
    across every topology, and `topology:plan-execute` across every framework.
    The second cut is the one this repo exists to make, and the one a separate
    project per framework would have made impossible.
  * a ContextVar, because concurrent requests must not see each other's axes.
  * no session id, because nothing can supply a correct one yet (#171).

THE PYTHON PLANE HAS NO TEST RUNNER IN CI — that is #80, and it means these do
not gate a merge yet. They run with `pytest` inside the backend container. Said
plainly rather than left to be discovered: a test file nothing executes is
worse than none, because it looks like coverage.
"""

import asyncio

import pytest

from ai_backends import _common


@pytest.fixture(autouse=True)
def _clear_axes():
    _common.set_run_axes()
    yield
    _common.set_run_axes()


def test_axes_become_filterable_tags():
    _common.set_run_axes(runtime="fastapi", framework="langgraph", topology="react")
    md = _common.langfuse_trace_metadata()
    assert set(md["langfuse_tags"]) == {
        "runtime:fastapi",
        "framework:langgraph",
        "topology:react",
    }


def test_tags_cut_both_ways():
    """The property that makes one project better than five.

    Every tag is `axis:value`, so selecting a framework and selecting a
    topology are the same operation. A trace NAME cannot do this: it is one
    string, and matching `react` in `fastapi-deepagents-react` also matches a
    hypothetical `react-agent` or `reactive`.
    """
    _common.set_run_axes(
        runtime="fastapi", framework="deepagents", topology="plan-execute"
    )
    tags = _common.langfuse_trace_metadata()["langfuse_tags"]
    assert "framework:deepagents" in tags
    assert "topology:plan-execute" in tags
    assert all(":" in t for t in tags)


def test_no_axes_means_no_metadata():
    """A request that never declared itself must not invent tags.

    Untagged is honest; `framework:unknown` would be a claim, and it would
    pollute the very filter these exist to make trustworthy.
    """
    _common.set_run_axes()
    assert _common.langfuse_trace_metadata() == {}


def test_none_valued_axes_are_dropped_not_stringified():
    """`None` must not become the string "None".

    An absent axis and one whose value is "None" are different facts, and a tag
    reading `topology:None` silently becomes a category in a dashboard.
    """
    _common.set_run_axes(runtime="fastapi", framework=None, topology="")
    assert _common.langfuse_trace_metadata()["langfuse_tags"] == ["runtime:fastapi"]


def test_no_session_id_is_emitted_today():
    """#171: nothing can supply a correct one.

    The client sends a hardcoded id for every conversation and the proxy
    replaces it with a fresh UUID per request — so the available values group
    either everything or nothing. Both are wrong in a way that looks right.
    """
    _common.set_run_axes(runtime="fastapi", framework="langchain", topology="react")
    assert "langfuse_session_id" not in _common.langfuse_trace_metadata()


def test_a_real_session_would_be_honoured():
    """The mechanism is ready for #171, and a session is not a tag.

    Tagging it would put a distinct value in the filter list for every
    conversation ever run, which destroys the list it joins.
    """
    _common.set_run_axes(framework="langchain", session="conv-abc")
    md = _common.langfuse_trace_metadata()
    assert md["langfuse_session_id"] == "conv-abc"
    assert md["langfuse_tags"] == ["framework:langchain"]


def test_axes_do_not_leak_between_concurrent_requests():
    """The reason this is a ContextVar and not a module global.

    Two requests in flight must each see their own axes. A global would hand
    whichever ran last to both, and the tags would be silently wrong under
    exactly the load where tracing matters most.
    """

    async def run(framework, hold):
        _common.set_run_axes(runtime="fastapi", framework=framework, topology="react")
        await asyncio.sleep(hold)
        return _common.langfuse_trace_metadata()["langfuse_tags"]

    async def both():
        return await asyncio.gather(run("langgraph", 0.02), run("deepagents", 0.0))

    a, b = asyncio.run(both())
    assert "framework:langgraph" in a
    assert "framework:deepagents" in b


def test_config_stays_empty_when_tracing_is_off():
    """`langfuse_config()` must stay `{}` when Langfuse is off.

    Its docstring explains why the empty form matters: an empty callbacks list
    REPLACES inherited callbacks on nested runs. Attaching metadata to a config
    that should be absent would reintroduce that by another route.
    """
    _common.set_run_axes(runtime="fastapi", framework="langchain", topology="react")
    if _common.langfuse_callbacks():
        assert _common.langfuse_config()["metadata"]["langfuse_tags"]
    else:
        assert _common.langfuse_config() == {}

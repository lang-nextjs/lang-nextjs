"""Where the checkpointer comes from, and that the injected one is the one USED (#643).

The saver was six module-level `InMemorySaver()` constants with no way to supply a
different one short of editing source. Every upstream surface treats it as a
parameter instead — `create_deep_agent(checkpointer=None)`, `compile(checkpointer=...)`,
langgraph's own `ensure_valid_checkpointer` error saying "Pass a proper saver
(e.g., InMemorySaver, AsyncPostgresSaver)", and LangGraph Platform injecting one.

THE FAILURE THIS FILE IS ORGANISED AROUND is a seam that ACCEPTS an injected saver
and then ignores it. `set_approval_saver_factory(x)` returning without error proves
nothing; a test asserting only that would pass against a parameter wired to
nothing, which is the same distinction as an export existing versus an app
mounting it. So the fake here COUNTS ITS CALLS and the assertion is that the count
moved during a real gated request.

AND THE DEFAULT PATH IS TESTED TOO, because it is the behaviour that already
existed, is least likely to be written down, and is most likely to be broken by
exactly this refactor. A fork that injects nothing must still gate.
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
from deepagents_backend.ai_backends import _common


class ScriptedModel(FakeMessagesListChatModel):
    """A fake chat model that accepts `bind_tools`."""

    def bind_tools(self, tools, **kwargs):  # noqa: ARG002
        return self

POLICY = {"approvalPolicy": {"readOnlyTools": ["read_file", "get_counter"]}}
MESSAGES = [{"role": "user", "content": "hello"}]


class CountingSaver(InMemorySaver):
    """An InMemorySaver that records that it was actually asked to do work.

    A SUBCLASS, NOT A MOCK, so a run that reaches it BEHAVES — the gate still
    pauses and the assertions above it stay meaningful. A stub returning None
    would make "the injected saver was used" true and "the gate works" false, and
    only one of those is being tested here.
    """

    instances: list = []

    def __init__(self):
        super().__init__()
        self.puts = 0
        CountingSaver.instances.append(self)

    def put(self, *args, **kwargs):
        self.puts += 1
        return super().put(*args, **kwargs)

    async def aput(self, *args, **kwargs):
        self.puts += 1
        return await super().aput(*args, **kwargs)


@pytest.fixture
def scripted(monkeypatch):
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
    monkeypatch.setattr(lc, "_graph", None)
    return counter


def _post():
    body = {
        "messages": MESSAGES,
        "topology": "react",
        "aiBackend": "langchain",
        "sessionId": "sess-seam-django",
        **POLICY,
    }

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


def test_an_INJECTED_saver_is_the_one_the_graph_USES(scripted, monkeypatch):
    """Not "the setter accepted it" — the injected object did the work."""
    CountingSaver.instances.clear()
    monkeypatch.setattr(_common, "_SAVER_FACTORY", CountingSaver)
    monkeypatch.setattr(_common, "_SAVERS", {})

    res, text = _post()
    assert res.status_code == 200 and "data-error" not in text, text

    assert CountingSaver.instances, (
        "the factory was set and never called, so the gated graph built its "
        "checkpointer from somewhere this seam does not control"
    )
    assert any(s.puts for s in CountingSaver.instances), (
        "the injected saver was constructed and never written to — a parameter "
        "that is accepted and then ignored, which is what this case exists to "
        "catch"
    )
    assert scripted[0] == 0, (
        "precondition: the gate must still have withheld the call, or the saver "
        "was exercised by a run that was not the one under test"
    )


def test_the_DEFAULT_path_still_gates_when_nothing_is_injected(scripted):
    """The behaviour that already existed, which a refactor is most likely to break."""
    assert _common._SAVER_FACTORY is InMemorySaver, (
        "the shipped default is no longer InMemorySaver — a fork now needs "
        "whatever this is, which is the severability cost #643 was scoped to avoid"
    )

    res, text = _post()
    assert res.status_code == 200 and "data-error" not in text, text
    assert scripted[0] == 0, "the default path did not withhold the call"
    assert "approval_pending" in text, (
        "the default path withheld the call and told the client nothing"
    )


def test_each_SCOPE_gets_its_own_saver(monkeypatch):
    """Two rungs must not share a thread namespace.

    MEASURED, because collapsing the six savers into one is the obvious
    simplification and it is wrong: `derive_thread_id` returns
    `approval:<sessionId>` with no rung in it, so two rungs sharing a saver share
    a thread for the same session. With one saver a second rung read 2 messages
    written by the first under the same id; with separate savers it read 0.
    """
    monkeypatch.setattr(_common, "_SAVERS", {})
    a = _common.approval_saver("deepagents_backend.ai_backends.langchain")
    b = _common.approval_saver("deepagents_backend.ai_backends.langgraph")

    assert a is not b, (
        "two rungs were handed the SAME checkpointer, so a decision for one "
        "rung's thread can resume the other's graph under the same sessionId"
    )
    assert _common.approval_saver("deepagents_backend.ai_backends.langchain") is a, (
        "the same scope built a second saver, so a resume would not find the "
        "thread its own earlier request created"
    )


def test_injecting_DISCARDS_savers_already_built(monkeypatch):
    """Otherwise a process holds two kinds of saver and no test covers the mix."""
    monkeypatch.setattr(_common, "_SAVERS", {})
    first = _common.approval_saver("deepagents_backend.ai_backends.langchain")

    monkeypatch.setattr(_common, "_SAVER_FACTORY", CountingSaver)
    _common.set_approval_saver_factory(CountingSaver)

    rebuilt = _common.approval_saver("deepagents_backend.ai_backends.langchain")
    assert rebuilt is not first, (
        "a saver built before the injection survived it, so which one a rung "
        "uses depends on whether it served a request first"
    )
    # AND IT CAME FROM THE INJECTED FACTORY. "is not first" alone is satisfied by a
    # seam that clears the cache and then ignores the factory — measured: with
    # `_SAVERS[scope] = InMemorySaver()` hardcoded, this case still passed while the
    # injection case failed. A fresh object of the WRONG type is the exact defect
    # this file exists to catch, one assertion further down than I first wrote it.
    assert isinstance(rebuilt, CountingSaver), (
        f"the cache was cleared but the replacement is {type(rebuilt).__name__}, "
        "not the injected factory's product — the seam discards and then ignores"
    )

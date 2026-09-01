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
    # A private checkpointer per test: `_APPROVAL_SAVER` is module-level so a resume can
    # find its thread between requests, which also means every test shares a thread
    # namespace under the same sessionId.
    monkeypatch.setattr(lc, "_APPROVAL_SAVER", InMemorySaver())
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

    langchain/react is armed (#332 C1); the others are not. Arming any of them means
    changing this test, deliberately, in the change that arms them.

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

    for name in ("langgraph", "deepagents"):
        try:
            mod = importlib.import_module(f"deepagents_backend.ai_backends.{name}")
        except ImportError:
            # Pruned by an eject. Not a skipped assertion — the module is genuinely
            # absent from this tree, so there is no set here to be wrong about.
            continue
        assert mod.GATED_TOPOLOGIES == frozenset(), (
            f"{name} is gated on this plane and nothing armed it deliberately"
        )

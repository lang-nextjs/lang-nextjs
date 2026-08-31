"""A GATED TOOL CALL PUTS NO TOOL FRAMES ON THE WIRE (#449, invariant I1).

WHY THIS IS THE ONE THAT MATTERS. #449 asked whether turning on `GATED_TOPOLOGIES`
stacks two gates on one tool call, and the answer was no — but the reason is a
property of UPSTREAM'S middleware rather than of anything in this repository:

  * the proxy gate's only trigger is `tool-input-start`
    (`packages/server/src/approval-gating.ts`),
  * and an upstream interrupt emits no tool frames at all, so that trigger never
    arrives for a gated call.

Both gates read one allowlist, so a tool is gated upstream exactly when the proxy
would have gated it. The two therefore cannot both fire, which is why #449 was
ruled "no bypass": a conditional to prevent the stacking could not have changed
any outcome.

That ruling rests entirely on the second bullet, and NOTHING ASSERTED IT. It was
a comment. If a future LangGraph streams the tool call before interrupting, both
gates fire, a user meets two approval surfaces for one call — one that withholds
the effect and one that withholds only the report — and it arrives silently, on a
code path nobody edited. This file is what turns that comment into a failure.

WHAT IT MEASURES, AND WHY NOT THE COUNTER. `test_approval_withholds.py` already
asserts the side effect does not happen, which is the right question for "does the
gate withhold". It is the WRONG question here: a tool can fail to run while its
call still streams. The observable that decides whether two gates can collide is
what reaches the wire, so these assertions read the emitted SSE frames from
`_stream_agent_events` — the real emission path, not a re-implementation of it.

BOTH PATHS, ALWAYS. The gated assertion alone is satisfied by a harness that
cannot produce a tool frame under any configuration — a criterion passing because
its input is uniform. The ungated case is the presence companion and it is not
decoration: it is the only thing establishing that a `tool_call` frame is
reachable here at all.

THE DJANGO PLANE. `stream_chat_react` is byte-identical across both backends and
`scripts/check-run-axes-parity.mjs` now enforces that, so this behaviour is proven
once and the identity is held mechanically. That is weaker than running it twice
and is stated rather than glossed: Django has no Python test harness in this repo
(zero `test_*.py` files), so a behavioural assertion there would mean building one.
"""

import asyncio
import sys
from pathlib import Path

from langchain.agents import create_agent
from langchain.agents.middleware import HumanInTheLoopMiddleware
from langchain_core.messages import AIMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ai_backends.langchain import _stream_agent_events  # noqa: E402
from test_approval_withholds import ScriptedModel  # noqa: E402

TOOL_NAME = "increment"
TOOL_CALL_ID = "call-1"


def _harness():
    """A tool that records execution, and a model that always calls it."""
    effects = [0]

    @tool
    def increment() -> str:
        """Increment the counter by 1 and return the new value."""
        effects[0] += 1
        return f"Counter incremented to {effects[0]}"

    model = ScriptedModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[{"name": TOOL_NAME, "args": {}, "id": TOOL_CALL_ID}],
            ),
            AIMessage(content="done"),
        ]
    )
    return effects, increment, model


def _frames(graph, config=None):
    """Every SSE frame the backend would put on the wire for one run."""

    async def collect():
        return [
            f
            async for f in _stream_agent_events(
                graph, {"messages": [{"role": "user", "content": "increment it"}]}, config
            )
        ]

    return asyncio.run(collect())


def _tool_frames(frames):
    return [f for f in frames if f.startswith("event: tool_call")]


def test_control_an_UNGATED_run_does_emit_a_tool_frame():
    """THE PRESENCE COMPANION. Without this, a zero below proves nothing.

    If this harness could not produce a `tool_call` frame under any configuration,
    the gated assertion would pass against a broken measurement — the shape this
    repository keeps finding, where a check reports green over the thing it exists
    to catch.
    """
    effects, increment, model = _harness()
    graph = create_agent(model=model, tools=[increment])
    frames = _frames(graph)

    assert _tool_frames(frames), (
        "the ungated run emitted no tool_call frame, so this harness cannot "
        f"observe tool frames and the gated assertion is vacuous. frames={frames}"
    )
    assert effects[0] == 1, "the ungated run did not execute the tool"


def test_a_GATED_run_emits_no_tool_frames_at_all():
    """THE CLAIM #449's RULING RESTS ON.

    The gate is configured, no decision is given. The tool must not run — already
    covered elsewhere — and, the part that matters here, NOTHING about the call may
    reach the wire. A `tool_call` frame here is the proxy gate's trigger, and its
    arrival alongside an upstream pause is precisely the double gate.
    """
    effects, increment, model = _harness()
    graph = create_agent(
        model=model,
        tools=[increment],
        middleware=[HumanInTheLoopMiddleware(interrupt_on={TOOL_NAME: True})],
        checkpointer=InMemorySaver(),
    )
    frames = _frames(graph, config={"configurable": {"thread_id": "gated"}})

    assert not _tool_frames(frames), (
        "an upstream-gated call emitted a tool frame. #449 was ruled 'no bypass' "
        "because a gated call cannot reach the proxy gate's only trigger; this "
        "frame is that trigger, so both gates can now claim one tool call and a "
        "user can meet two approval surfaces for it. Re-open #449 — do not "
        f"suppress this assertion. frames={frames}"
    )
    assert effects[0] == 0, (
        "the tool ran while approval was pending — a different defect (#261), but "
        "it would also make the frame assertion above meaningless"
    )

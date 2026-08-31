"""A GATED RUN NEVER CLOSES SILENTLY, AND A DECISION COMPOSES BACK INTO IT (#332 A1, A2).

WHAT HAD NEVER HAPPENED. #420's machinery is built — the pause frame, the schema, the card, the
render, the resume route, the four-way vocabulary — and all six `GATED_TOPOLOGIES` are
`frozenset()`. So every existing assertion is driven by a CONSTRUCTED gated graph or an INJECTED
fixture frame, never by a run that paused and then resumed. The path is proven in pieces and has
never been proven AS A PATH.

────────────────────────────────────────────────────────────────────────────────────────────
NOTHING HERE READS `GATED_TOPOLOGIES`, AND THAT IS THE LOAD-BEARING CONSTRAINT.

`stream_chat_react` decides `gated = "react" in GATED_TOPOLOGIES`, so driving these assertions
through the dispatch would make them VACUOUS while the sets are empty — passing because the
gated branch is never taken, and vacuous-by-construction is worse than missing because it reads
as covered. The gate is supplied HERE by construction: a real `HumanInTheLoopMiddleware` on a
real graph. Nothing asks the configuration whether to expect a pause.

THE COST OF THAT, STATED. These tests compose `_stream_agent_events` and
`_pending_approval_events` the way `stream_chat_react` composes them, which duplicates that
ordering. If the dispatch ever composed them differently, these would still pass. The
alternative — calling the dispatch — buys that at the price of asserting nothing at all today,
which is the worse trade. `check-run-axes-parity.mjs` holds the two backends identical, so this
is proven once for both planes.

WHY THE COMPOSED SEQUENCE AND NOT THE STREAM ALONE. Measured while writing this: a gated run
through `_stream_agent_events` ALONE emits ZERO frames. The pause is not a stream event — an
interrupted run ends its iteration normally and the pause is on the graph STATE, read after the
stream drains. So an assertion against the generator by itself would fail for the wrong reason,
reporting "no pause" about a function that never emits one. The wire sequence is both.
────────────────────────────────────────────────────────────────────────────────────────────
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

from ai_backends import _common  # noqa: E402
from ai_backends.langchain import (  # noqa: E402
    _pending_approval_events,
    _stream_agent_events,
)
from test_approval_withholds import ScriptedModel  # noqa: E402

TOOL_NAME = "increment"


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
                tool_calls=[{"name": TOOL_NAME, "args": {}, "id": "call-1"}],
            ),
            AIMessage(content="done"),
        ]
    )
    return effects, increment, model


def _gated_graph(increment, model):
    return create_agent(
        model=model,
        tools=[increment],
        middleware=[HumanInTheLoopMiddleware(interrupt_on={TOOL_NAME: True})],
        checkpointer=InMemorySaver(),
    )


def _wire(graph, agent_input, config=None):
    """Every frame the backend puts on the wire for one run, composed as the dispatch does."""

    async def drain():
        return [f async for f in _stream_agent_events(graph, agent_input, config)]

    return asyncio.run(drain()) + _pending_approval_events(graph, config)


_TURN = {"messages": [{"role": "user", "content": "increment it"}]}
_pauses = lambda fs: [f for f in fs if f.startswith("event: approval_pending")]
_results = lambda fs: [f for f in fs if f.startswith("event: tool_end")]


def test_control_an_UNGATED_run_emits_a_result_and_NO_pause():
    """THE PRESENCE COMPANION, AND IT CARRIES BOTH HALVES.

    The invariant below is a disjunction — a pause OR a result — so a harness that could produce
    neither would satisfy it vacuously, and a harness that produced a pause unconditionally
    would satisfy it for the wrong reason. This establishes that BOTH arms are reachable here:
    an ungated run really does emit a result, and really does not emit a pause. Without it,
    "the gated run paused" is a statement about a system that pauses everything.
    """
    effects, increment, model = _harness()
    frames = _wire(create_agent(model=model, tools=[increment]), _TURN)

    assert _results(frames), (
        f"the ungated run emitted no tool_end, so this harness cannot observe a RESULT and "
        f"the invariant below is untestable in one of its two arms. frames={frames}"
    )
    assert not _pauses(frames), (
        f"the ungated run emitted a pause, so 'the gated run paused' would be true of every "
        f"run and would say nothing about gating. frames={frames}"
    )
    assert effects[0] == 1, "the ungated run did not execute the tool"


def test_A1_a_gated_run_never_closes_having_emitted_NEITHER_a_result_NOR_a_pause():
    """#420's defect, in its assertable form: withholds execution and tells nobody.

    A gate that withholds is correct. A gate that withholds SILENTLY is the defect — the client
    receives a closed stream carrying no result and no reason, indistinguishable from a run that
    simply produced nothing.
    """
    effects, increment, model = _harness()
    graph = _gated_graph(increment, model)
    config = {"configurable": {"thread_id": "a1-gated"}}
    frames = _wire(graph, _TURN, config)

    assert _results(frames) or _pauses(frames), (
        "a gated run closed having emitted NEITHER a tool result NOR a pause. The tool was "
        "withheld and nothing said so, which is a silent stream — the client cannot tell this "
        f"from a run that produced nothing. frames={frames}"
    )
    # WHICH ARM SATISFIED IT. The disjunction alone would also be satisfied by a run that
    # executed the tool, which for a gated call would be a DIFFERENT and worse defect (#261).
    assert _pauses(frames), f"satisfied by a result rather than a pause. frames={frames}"
    assert effects[0] == 0, (
        "the tool ran while approval was pending, so the pause above announced a decision that "
        "had already been taken"
    )


def test_A2_the_round_trip_composes_pause_out_decision_in_tool_runs():
    """SEGMENTS COMPOSING IS A DIFFERENT CLAIM FROM SEGMENTS EXISTING (#332 A2).

    Both halves are asserted today in different files — one that a gated run pauses, another
    that a resume command re-enters the graph — and nothing asserted that a decision made
    against the pause this run emitted causes this run's tool to execute. That is the whole
    point: two green segments and no path.

    The decision travels through the REAL request-parsing code, `parse_approval_decisions` ->
    `set_approval_decisions` -> `approval_resume_command`, which is what the resume route calls.
    Constructing a `Command` directly would skip the half of the path most likely to be wrong —
    #332 records that a bare list here raises "list indices must be integers", which reads as
    "resume does not work" rather than "the payload has the wrong shape".
    """
    effects, increment, model = _harness()
    graph = _gated_graph(increment, model)
    config = {"configurable": {"thread_id": "a2-round-trip"}}

    # LEG 1 — the pause goes out and the tool does not run.
    first = _wire(graph, _TURN, config)
    assert _pauses(first), f"no pause to decide against. frames={first}"
    assert effects[0] == 0, "the tool ran before any decision was given"

    # THE DECISION, through the same helpers the route uses.
    body = {_common.DECISIONS_FIELD: [{"type": "approve"}]}
    _common.set_approval_decisions(_common.parse_approval_decisions(body))
    resume = _common.approval_resume_command()
    assert resume is not None, (
        "the decisions parsed but produced no resume command, so the second leg would start a "
        "NEW TURN rather than re-entering the paused one — a new turn wearing a decision's "
        "clothes, with the tool call still pending"
    )

    # LEG 2 — the same graph, resumed, executes the tool it withheld.
    second = _wire(graph, resume, config)

    assert effects[0] == 1, (
        "the approved tool did not execute on resume. The pause and the resume are each "
        f"asserted elsewhere; this is the composition failing. frames={second}"
    )
    assert _results(second), (
        f"the tool executed but its result never reached the wire, so the approving client "
        f"sees the same silence the pause was meant to end. frames={second}"
    )
    assert not _pauses(second), (
        f"the resumed run paused again on a call that had already been approved. frames={second}"
    )

"""THE GATE MUST WITHHOLD EXECUTION, not report a decision it never enforced (#261, #332).

Today's approval gate lives in the proxy, downstream of the backend that already ran the
tool. `packages/server/src/approval-gating.ts` says so in its own header: "dropping the
frames withholds the REPORT, not the effect", measured as the counter moving 65 -> 66 while
nobody approved anything. An approval card that says "Approval required" for something
already done is worse than no card.

WHAT THIS FILE MEASURES, AND WHY IT IS A COUNTER.

The whole question is one observable: DID THE SIDE EFFECT HAPPEN. Not "was a frame emitted",
not "did a state say approval-requested" — those are reports, and a report is the thing that
was already wrong. So the tool under test increments an in-process counter and the assertion
is on that integer.

`"we now use needsApproval"` is a claim about code. `"the counter did not move"` is a claim
about the world, and it is the only one worth making here.

THE MODEL IS SCRIPTED, deliberately. A real model that happens not to call the tool produces
a zero-effect run that looks exactly like a withheld one — the false green this repo keeps
finding. `FakeMessagesListChatModel` emits the same tool call every time, so "the model chose
differently" cannot explain either outcome.

BOTH DIRECTIONS, and the control before either.

  control    no gate configured          -> 1 effect   the harness can observe execution
  withheld   gated, no decision given    -> 0 effects  the claim
  approved   gated, decision given       -> 1 effect   the gate is not simply broken

The control is not ceremony. Without it, "0 effects" is equally consistent with a harness that
never ran the agent at all, and a suite that cannot tell those apart reports the same green
for both. The approve case is the presence companion: a test proving denial blocks, with
nothing proving approval permits, is satisfied by a gate that blocks everything.
"""

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage
from langchain_core.tools import tool
from langchain.agents import create_agent
from langchain.agents.middleware import HumanInTheLoopMiddleware
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

TOOL_NAME = "increment"
TOOL_CALL_ID = "call_increment_1"


class ScriptedModel(FakeMessagesListChatModel):
    """A fake chat model that accepts `bind_tools`.

    `FakeMessagesListChatModel` raises NotImplementedError from `bind_tools`, and every agent
    binds its tools before the first turn — so the plain fake fails before the question this
    file asks is ever reached. Binding is a no-op here BY DESIGN: the scripted replies are the
    point, and a fake that consulted the bound tools could choose differently between the
    control and the gated runs, which is the one explanation this harness exists to remove.
    """

    def bind_tools(self, tools, **kwargs):  # noqa: ANN001, ANN003, D102
        return self


def _harness():
    """A counter, a tool that bumps it, and a model that always calls that tool.

    The counter is a one-element list rather than an int so the tool closes over a mutable
    cell — the assertion reads the same object the tool wrote, with no module-level state to
    leak between tests.
    """
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
            # The turn after the tool result. Without a second scripted reply the fake model
            # raises when the agent loops back to it, and the test would fail for a reason
            # that has nothing to do with approval.
            AIMessage(content="done"),
        ]
    )
    return effects, increment, model


def _run(agent, config=None):
    for _ in agent.stream(
        {"messages": [{"role": "user", "content": "increment it by 1"}]},
        config=config,
        stream_mode="values",
    ):
        pass


def test_control_the_harness_can_observe_execution():
    """No gate. If this does not reach 1, every other number in this file means nothing."""
    effects, increment, model = _harness()
    agent = create_agent(model=model, tools=[increment])
    _run(agent)
    assert effects[0] == 1, (
        "the ungated agent did not execute the tool, so this harness cannot measure "
        "execution and a 0 below would prove nothing"
    )


def test_an_unanswered_approval_withholds_execution():
    """THE CLAIM. The gate is configured, no decision is ever given, and the tool must not run.

    This is what today's proxy-side gate cannot do: it sees the tool frames only after the
    backend has run the tool, so it can drop the report and not the effect.
    """
    effects, increment, model = _harness()
    agent = create_agent(
        model=model,
        tools=[increment],
        middleware=[HumanInTheLoopMiddleware(interrupt_on={TOOL_NAME: True})],
        checkpointer=InMemorySaver(),
    )
    _run(agent, config={"configurable": {"thread_id": "withheld"}})

    assert effects[0] == 0, (
        "the tool ran while an approval was still pending — the gate reported a decision "
        "it never enforced, which is the defect in #256/#261"
    )


def test_an_approved_call_is_then_executed():
    """The presence companion. A gate that blocks everything would satisfy the test above."""
    effects, increment, model = _harness()
    agent = create_agent(
        model=model,
        tools=[increment],
        middleware=[HumanInTheLoopMiddleware(interrupt_on={TOOL_NAME: True})],
        checkpointer=InMemorySaver(),
    )
    config = {"configurable": {"thread_id": "approved"}}
    _run(agent, config=config)
    assert effects[0] == 0, "precondition: the call must be pending before it is approved"

    # A DICT WITH `decisions`, not a bare list. A list raises
    # `TypeError: list indices must be integers or slices, not str` — recorded in #332
    # because it is the kind of shape error that reads as "resume does not work".
    for _ in agent.stream(
        Command(resume={"decisions": [{"type": "approve"}]}),
        config=config,
        stream_mode="values",
    ):
        pass

    assert effects[0] == 1, (
        "the approved call never executed — a gate that withholds an approved call is not "
        "a gate, it is an outage"
    )


def test_a_rejected_call_is_never_executed():
    """Reject is not the same code path as never-answering, and it is the one a user picks."""
    effects, increment, model = _harness()
    agent = create_agent(
        model=model,
        tools=[increment],
        middleware=[HumanInTheLoopMiddleware(interrupt_on={TOOL_NAME: True})],
        checkpointer=InMemorySaver(),
    )
    config = {"configurable": {"thread_id": "rejected"}}
    _run(agent, config=config)

    for _ in agent.stream(
        Command(
            resume={"decisions": [{"type": "reject", "message": "no thanks"}]}
        ),
        config=config,
        stream_mode="values",
    ):
        pass

    assert effects[0] == 0, "a rejected call executed anyway"

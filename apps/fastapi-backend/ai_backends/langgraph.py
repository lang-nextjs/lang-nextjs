"""LangGraph AI backend — exposes two topologies:

  - "react"        → `langgraph.prebuilt.create_react_agent`. Tool-calling loop,
                     prebuilt convenience function. The default and most common
                     LangGraph pattern.
  - "plan-execute" → custom StateGraph (planner → executor → replanner) ported
                     from the official notebook
                     https://github.com/langchain-ai/langgraph/blob/main/examples/plan-and-execute/plan-and-execute.ipynb
                     Showcases LangGraph's actual abstraction beyond the
                     prebuilt — separate phases, explicit nodes, conditional
                     edges.

Both topologies emit raw `astream_events` JSON over the wire — same format that
`langgraph-cli dev` and LangGraph Cloud produce. The matching `langGraphAdapter`
in packages/server/src/adapters/langgraph.ts normalizes either to AI SDK v6.
"""

import json
import operator
from typing import Annotated, List, Tuple, TypedDict, Union

from langchain_core.prompts import ChatPromptTemplate
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt import create_react_agent
from langgraph.types import interrupt
from pydantic import BaseModel, Field

from ._common import (
    _DECISION_TYPES,
    _pending_approval_events,
    approval_interrupt_on,
    approval_resume_command,
    approval_thread_config,
    SYSTEM_PROMPT,
    TOOLS,
    langfuse_config,
    make_llm,
)


_INTERESTING_EVENTS = frozenset(
    {"on_chat_model_stream", "on_tool_start", "on_tool_end"}
)

# Nodes whose `on_chat_model_stream` events emit raw JSON from
# `with_structured_output` chains. We hide these tokens from the wire — they
# are internal data-shape generation, not user-facing prose. Tool calls and
# the final response surface through other channels (the executor node's
# natural-language stream and the StateGraph state's `response` field).
_STRUCTURED_OUTPUT_NODES = frozenset({"planner", "replanner"})


def _should_emit(event: dict) -> bool:
    if event.get("event") not in _INTERESTING_EVENTS:
        return False
    if event.get("event") == "on_chat_model_stream":
        node = (event.get("metadata") or {}).get("langgraph_node", "")
        if node in _STRUCTURED_OUTPUT_NODES:
            return False
    return True


# ---------------------------------------------------------------------------
# Topology 1: ReAct (prebuilt)
# ---------------------------------------------------------------------------

_react_graph = None


def get_react_graph():
    global _react_graph
    if _react_graph is None:
        _react_graph = create_react_agent(
            make_llm(),
            tools=TOOLS,
            prompt=SYSTEM_PROMPT,
            name="fastapi-langgraph-react",
        )
    return _react_graph


# Kept for backward compat with main.py lifespan and any callers that imported
# `langgraph.get_graph()` before the topology axis existed.
def get_graph():
    return get_react_graph()


# ---------------------------------------------------------------------------
# THE APPROVAL GATE FOR THIS RUNG (#332 step C2/C3).
#
# WHY NOT `interrupt_before=["tools"]`, WHICH IS WHAT #332's TABLE SAYS. Measured
# against langgraph 1.2.11 before choosing, and it fails on two counts:
#
#   * IT EMITS NO PAYLOAD. `interrupt_before` stops the graph before a node; it
#     does not call `interrupt()`, so `state.tasks[].interrupts` is EMPTY. The
#     effect is correctly withheld -- 0 side effects at the pause, measured --
#     and the client is told nothing: a 200, one empty message frame, silence.
#     That is the exact defect langchain.py documents as the reason the gate
#     could not be armed until an approval frame existed (#413 shipped disarmed
#     for it), and it would have been reintroduced here by following the table.
#
#   * IT IS NODE-LEVEL, AND THE POLICY IS PER-TOOL. `interrupt_before` pauses
#     before the whole tools node whatever tool was called, so a request whose
#     policy allowlists `get_counter` as read-only would still pause on it. The
#     other plane, using HumanInTheLoopMiddleware's `interrupt_on` map, would
#     not. Two runtimes answering the same policy differently is precisely the
#     divergence this repo exists to make visible.
#
# So the gate is langgraph's own `interrupt()`, called from a `post_model_hook`
# that reads the model's proposed tool calls and pauses only on the ones the
# request's policy does not excuse. Measured, four cells:
#
#   gated tool       0 effects at the pause, 1 interrupt, effect runs on resume
#   allowlisted tool no pause, no interrupt, and the tool RAN -- the presence
#                    companion, without which "did not pause" is also satisfied
#                    by a tool that never executed at all
#
# WE AUTHOR THIS PAYLOAD, AND THAT IS A REAL COST. #332 says the four-way
# vocabulary is carried faithfully rather than translated, which on the
# langchain rung means passing upstream's own dict through. There is no upstream
# payload to pass here: the middleware that builds one lives in langchain, and
# reaching for it would make this rung a copy of that one rather than a LangGraph
# demonstration. So the shape is authored to match, and
# `test_approval_payload_shape` asserts it against what the langchain plane
# actually emits rather than against a copy of this dict -- otherwise the two
# drift and nothing compares them.
# ---------------------------------------------------------------------------

# ONE SAVER FOR THE PROCESS, NOT ONE PER REQUEST -- the reasoning is
# langchain.py's and is the same here: a decision arrives on a LATER request,
# and a per-request saver makes every approval the lost-checkpoint case.
_APPROVAL_SAVER = InMemorySaver()


def _approval_gate(state):
    """Pause before any tool call this request's policy does not excuse.

    Runs after the model and before the tools node, which is the only point
    where the proposed calls are known and none of them has run yet.
    """
    last = state["messages"][-1]
    interrupt_on = approval_interrupt_on(t.name for t in TOOLS)
    pending = [
        call
        for call in getattr(last, "tool_calls", None) or []
        if interrupt_on.get(call["name"])
    ]
    if not pending:
        # NOT AN ERROR AND NOT A GAP. Either the model called nothing, or every
        # call it made is allowlisted -- and an allowlisted call is meant to run.
        return None
    # THE SHAPE UPSTREAM ACTUALLY EMITS, MEASURED RATHER THAN QUOTED.
    #
    # `action_requests` paired BY INDEX with `review_configs`, snake_case, which
    # is what docs/sse-frame-schema.json calls the contract and what
    # packages/react's ApprovalPauseSchema parses. Measured on langchain 1.3.18
    # and deepagents 0.7.11: both middlewares emit
    #
    #     action_requests: [{name, args, description}]
    #     review_configs:  [{action_name, allowed_decisions}]
    #
    # #332's issue body quotes a flat `{action_name, allowed_decisions}`, which
    # neither produces. The first version of this function was built from that
    # quote and emitted `action_requests[].action_name` with a top-level
    # `allowed_decisions` — a payload the card's schema rejects, so a gated pause
    # would have rendered with no action name and no buttons. The rung's own test
    # asserted the invented shape and was green.
    #
    # THIS RUNG AUTHORS THE PAYLOAD and the other two pass upstream's through, so
    # only here can the two drift. packages/test-utils' approval-pause
    # conformance suite drives the real adapter against the real schema for every
    # gating rung, which is what makes the drift visible rather than latent.
    interrupt(
        {
            "action_requests": [
                {
                    "name": call["name"],
                    "args": call["args"],
                    "description": (
                        "Tool execution requires approval\n\n"
                        f"Tool: {call['name']}\nArgs: {call['args']}"
                    ),
                }
                for call in pending
            ],
            # PAIRED BY INDEX with action_requests above, one config per call.
            #
            # THE VOCABULARY WE WILL ACCEPT, NOT A LITERAL BESIDE IT.
            # `_DECISION_TYPES` is what parse_approval_decisions accepts on the
            # way back in; offering a decision the parser would reject is a
            # promise the next request breaks, and two hardcoded lists in one
            # repo is how they come to differ.
            "review_configs": [
                {
                    "action_name": call["name"],
                    "allowed_decisions": list(_DECISION_TYPES),
                }
                for call in pending
            ],
        }
    )
    return None


def get_gated_react_graph():
    """Build this request's react agent, gated by the policy the dispatch parsed.

    Built fresh each call rather than cached in a module global: the policy is
    per-request, so a cached graph would serve the first request's allowlist to
    every later one.
    """
    return create_react_agent(
        make_llm(),
        tools=TOOLS,
        prompt=SYSTEM_PROMPT,
        name="fastapi-langgraph-react",
        post_model_hook=_approval_gate,
        checkpointer=_APPROVAL_SAVER,
    )


# ---------------------------------------------------------------------------
# Topology 2: Plan-and-Execute (StateGraph custom topology)
# ---------------------------------------------------------------------------


class PlanExecuteState(TypedDict):
    """State carried through the plan-execute graph.

    `input`: the original user request — never mutated.
    `plan`: ordered list of remaining steps. Mutated by replanner.
    `past_steps`: append-only log of (step, result) pairs. The Annotated
        operator.add tells LangGraph this field is reduced by concatenation
        when nodes return partial updates.
    `response`: terminal field; non-empty signals "we're done — exit graph."
    """

    input: str
    plan: List[str]
    past_steps: Annotated[List[Tuple[str, str]], operator.add]
    response: str


class _Plan(BaseModel):
    """Structured output schema for the planner."""

    steps: List[str] = Field(
        description="Ordered, atomic steps to accomplish the user's request. "
        "Each step should be specific enough that an executor agent can act "
        "on it in a single turn."
    )


class _Response(BaseModel):
    """Terminal response — used by the replanner when no more steps needed."""

    response: str


class _ReplanAction(BaseModel):
    """Replanner output — either continue with new plan or finish."""

    action: Union[_Response, _Plan] = Field(
        description="If the past steps already answer the user, return _Response. "
        "Otherwise return _Plan with the remaining steps."
    )


_plan_execute_graph = None


def _build_plan_execute_graph():
    """Build the plan-execute StateGraph. Compiled once, cached, reused."""
    llm = make_llm()

    # Planner: turns the user request into an ordered list of atomic steps.
    planner_prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                "For the given user request, produce a concise step-by-step plan. "
                "Each step should be a single concrete action an executor agent "
                "can perform in one turn. Do not skip steps; do not add steps that "
                "aren't needed. The final step should produce the answer.",
            ),
            ("user", "{input}"),
        ]
    )
    planner = (planner_prompt | llm.with_structured_output(_Plan)).with_config(
        {"run_name": "fastapi-langgraph-plan-execute-planner"}
    )

    # Executor: reuses the prebuilt ReAct agent to run each step in turn.
    # By using a sub-agent for execution, the executor handles tool calls
    # (increment, get_counter) without us re-implementing the loop.
    executor = create_react_agent(
        llm,
        tools=TOOLS,
        prompt=SYSTEM_PROMPT,
        name="fastapi-langgraph-plan-execute-executor",
    )

    # Replanner: looks at past steps + remaining plan, decides whether to
    # finish (return _Response) or continue (return _Plan with revised steps).
    replanner_prompt = ChatPromptTemplate.from_messages(
        [
            (
                "system",
                "You are revising an in-progress plan. Given the user's original "
                "request, the original plan, the past steps already executed, "
                "and the remaining plan, either:\n"
                "  - return a _Response if the past steps already answer the request, OR\n"
                "  - return a _Plan with the remaining steps (you may revise them).\n"
                "Prefer _Response when possible — don't repeat work.",
            ),
            (
                "user",
                "Request: {input}\n\nOriginal plan: {plan}\n\n"
                "Past steps:\n{past_steps}\n\nRemaining plan: {remaining}",
            ),
        ]
    )
    replanner = (
        replanner_prompt | llm.with_structured_output(_ReplanAction)
    ).with_config({"run_name": "fastapi-langgraph-plan-execute-replanner"})

    async def plan_step(state: PlanExecuteState):
        plan = await planner.ainvoke({"input": state["input"]})
        return {"plan": plan.steps, "past_steps": []}

    async def execute_step(state: PlanExecuteState):
        if not state["plan"]:
            return {"response": "Plan empty — nothing to execute."}
        task = state["plan"][0]
        # Pass the executor BOTH the original goal and the current step.
        # Without the original goal, the executor sometimes treats steps as
        # read-only (e.g. "get current value") instead of mutating actions
        # (e.g. "call increment()"). With the goal in context, it picks the
        # right tool. Pattern from the LangGraph plan-execute notebook.
        agent_input = {
            "messages": [
                {
                    "role": "user",
                    "content": (
                        f"Overall user request: {state['input']}\n\n"
                        f"Your current sub-step: {task}\n\n"
                        "Use the available tools to actually perform the action. "
                        "Do not just describe — invoke the tool API."
                    ),
                }
            ]
        }
        result = await executor.ainvoke(agent_input)
        last_message = result["messages"][-1]
        result_text = (
            last_message.content
            if hasattr(last_message, "content")
            else str(last_message)
        )
        return {
            "past_steps": [(task, result_text)],
            "plan": state["plan"][1:],
        }

    async def replan_step(state: PlanExecuteState):
        action = await replanner.ainvoke(
            {
                "input": state["input"],
                "plan": state.get("plan", []),
                "past_steps": "\n".join(
                    f"- {step}: {result}" for step, result in state["past_steps"]
                ),
                "remaining": state.get("plan", []),
            }
        )
        if isinstance(action.action, _Response):
            return {"response": action.action.response}
        return {"plan": action.action.steps}

    def should_finish(state: PlanExecuteState):
        # Done when we have a response, or when the plan is empty after a
        # replan (indicating the replanner couldn't produce new steps).
        if state.get("response"):
            return END
        if not state.get("plan"):
            return END
        return "executor"

    workflow = StateGraph(PlanExecuteState)
    workflow.add_node("planner", plan_step)
    workflow.add_node("executor", execute_step)
    workflow.add_node("replanner", replan_step)
    workflow.add_edge(START, "planner")
    workflow.add_edge("planner", "executor")
    workflow.add_edge("executor", "replanner")
    workflow.add_conditional_edges(
        "replanner", should_finish, {END: END, "executor": "executor"}
    )
    return workflow.compile().with_config({"run_name": "fastapi-langgraph-plan-execute"})


def get_plan_execute_graph():
    global _plan_execute_graph
    if _plan_execute_graph is None:
        _plan_execute_graph = _build_plan_execute_graph()
    return _plan_execute_graph


# ---------------------------------------------------------------------------
# Wire-format helpers (shared)
# ---------------------------------------------------------------------------


def _default(obj):
    """Serialize LangChain objects to structured dicts (not repr strings).

    Real LangGraph Cloud emits structured JSON for messages. Without this,
    ToolMessage/AIMessageChunk objects fall back to `str(obj)` which produces
    a Python repr — breaks downstream adapters that expect dict shape.
    """
    if hasattr(obj, "model_dump"):
        try:
            return obj.model_dump()
        except Exception:
            pass
    return str(obj)


def _safe_json(obj) -> str:
    return json.dumps(obj, default=_default)


# ---------------------------------------------------------------------------
# Topology dispatch — each topology has its own state shape, so they have
# their own stream functions rather than one common helper.
# ---------------------------------------------------------------------------


def approval_thread_holds_a_pause(config) -> bool:
    """Does this thread still hold the interrupt a decision would answer? (#399)

    THE DISPATCH CALLS THIS BY NAME ON WHICHEVER MODULE IT ROUTED TO, so arming a
    rung without defining it is an AttributeError on the decisions path and only
    there -- a first message in a gated topology never reaches it. The langchain
    rung has had this since #399; this rung needed it the moment it appeared in
    GATED_TOPOLOGIES, and nothing in the declaration says so.

    THE SAME READER THE EMITTER USES, deliberately, for langchain.py's reason:
    asking a second question a second way is how "the card says pending" and "the
    backend thinks it is pending" come to disagree.

    A LOST THREAD AND A NEVER-RUN THREAD READ IDENTICALLY HERE -- both hold zero
    interrupts -- so this is only half a predicate, and the dispatch supplies the
    other half by asking it only when decisions were actually sent.
    """
    return bool(_pending_approval_events(get_gated_react_graph(), config))


async def stream_chat_react(messages):
    """ReAct topology — prebuilt create_react_agent."""
    # THE DECLARATION DECIDES BOTH ENDS, exactly as on the langchain rung: the
    # dispatch reads GATED_TOPOLOGIES to know whether to demand a policy, and
    # this reads the same constant to know whether to build a gated graph.
    # Deciding independently here is how the two come to disagree.
    gated = "react" in GATED_TOPOLOGIES
    graph = get_gated_react_graph() if gated else get_react_graph()
    # MERGED AT THE CALL SITE, NOT CHOSEN BETWEEN. `langfuse_config()` carries the
    # callbacks and the metadata; the gated path adds `configurable.thread_id`.
    # The first version of this line was a ternary picking one or the other, so
    # every gated turn ran with no callbacks while `/health` went on reporting the
    # backend as traced — an endpoint made to lie by one line. The two dicts share
    # no keys, so a shallow merge is the whole of it, and langchain.py's
    # `_stream_agent_events` has said exactly this since #413; porting this rung's
    # dispatch without reading that far is how the same defect reaches a second rung.
    #
    # WRITTEN IN THE INVOCATION rather than hoisted into a variable, because
    # check-langfuse-wiring reads the call site for `langfuse_config()` and that is
    # not a formality: a hoisted `config=config` is as opaque to someone scanning
    # for untraced paths as it is to the checker.
    thread = approval_thread_config() if gated else {}
    # A RESUME RE-ENTERS THE GRAPH; IT DOES NOT START A TURN. Passing the
    # messages again would append the user's text a second time and run the
    # model afresh, leaving the pending call pending.
    resume = approval_resume_command() if gated else None
    agent_input = resume if resume is not None else {"messages": messages}
    async for event in graph.astream_events(
        agent_input,
        version="v2",
        config={**langfuse_config(), **thread},
    ):
        if _should_emit(event):
            yield f"data: {_safe_json(event)}\n\n"

    # AFTER THE STREAM DRAINS, NOT DURING. An interrupted run ends its event
    # stream normally -- no event names the pause -- so the state can only be
    # asked once the iteration is done.
    if gated:
        for frame in _pending_approval_events(graph, thread):
            yield frame

    yield "data: [DONE]\n\n"


async def stream_chat_plan_execute(messages):
    """Plan-Execute topology — custom StateGraph (planner → executor → replanner)."""
    graph = get_plan_execute_graph()
    user_text = messages[-1]["content"] if messages else ""
    async for event in graph.astream_events(
        {"input": user_text}, version="v2", config=langfuse_config()
    ):
        if _should_emit(event):
            yield f"data: {_safe_json(event)}\n\n"
    yield "data: [DONE]\n\n"


# Public dispatch surface — main.py reads this to route by body.topology.
# WHICH TOPOLOGIES ENFORCE APPROVAL, stated rather than discovered (#332).
#
# ARMED FOR `react`, ON THIS RUNG, ON BOTH PLANES (#332 steps C2/C3).
#
# `plan-execute` is NOT armed and its absence here is a position, not an
# oversight: that topology has not been measured on this rung, and a declaration
# is the wrong place to express a hope. It still relies on the proxy-side
# transform, which withholds the REPORT and not the effect (#256).
#
# BOTH PLANES IN ONE CHANGE, DELIBERATELY. check-run-axes-parity compares this
# constant across the two runtimes since #592, so arming one plane alone is
# correctly red -- the planes would gate different topologies for the same
# request, which is what that check exists to refuse.
GATED_TOPOLOGIES = frozenset({"react"})

TOPOLOGIES = {
    "react": stream_chat_react,
    "plan-execute": stream_chat_plan_execute,
}

# Backward compat: external callers may still reference `stream_chat`.
stream_chat = stream_chat_react


def warmup() -> None:
    """Eager-init so first-request latency and import errors surface at boot.

    Called by main.py's lifespan THROUGH _MODULES, so it disappears with this
    module when `pnpm eject` drops the rung. Do not call it by name from main.
    """
    get_graph()

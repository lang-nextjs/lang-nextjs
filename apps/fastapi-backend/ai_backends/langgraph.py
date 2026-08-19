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
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt import create_react_agent
from pydantic import BaseModel, Field

from ._common import SYSTEM_PROMPT, TOOLS, make_llm


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


async def stream_chat_react(messages):
    """ReAct topology — prebuilt create_react_agent."""
    graph = get_react_graph()
    async for event in graph.astream_events({"messages": messages}, version="v2"):
        if _should_emit(event):
            yield f"data: {_safe_json(event)}\n\n"
    yield "data: [DONE]\n\n"


async def stream_chat_plan_execute(messages):
    """Plan-Execute topology — custom StateGraph (planner → executor → replanner)."""
    graph = get_plan_execute_graph()
    user_text = messages[-1]["content"] if messages else ""
    async for event in graph.astream_events({"input": user_text}, version="v2"):
        if _should_emit(event):
            yield f"data: {_safe_json(event)}\n\n"
    yield "data: [DONE]\n\n"


# Public dispatch surface — main.py reads this to route by body.topology.
TOPOLOGIES = {
    "react": stream_chat_react,
    "plan-execute": stream_chat_plan_execute,
}

# Backward compat: external callers may still reference `stream_chat`.
stream_chat = stream_chat_react

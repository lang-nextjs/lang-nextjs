"""LangChain AI backend — exposes two topologies:

  - "react"        → `langchain.agents.create_agent` (LangChain 1.x ReAct).
                     Tool-calling loop. Single agent, one model call per step.
  - "plan-execute" → custom planner harness wrapping `create_agent`. The
                     planner uses `model.with_structured_output(Plan)` to
                     produce an ordered list of steps (no graph). Then for
                     each step, an executor `create_agent` instance runs and
                     streams its events. Demonstrates that LC 1.x can
                     express non-prebuilt topologies even though it doesn't
                     ship a PlanAndExecute primitive (deprecated in 0.x).

In LangChain 1.x, `AgentExecutor` + `create_openai_tools_agent` was replaced
by a single `create_agent(model, tools, system_prompt=...)` factory that
returns a CompiledStateGraph. Both topologies use it under the hood — the
difference is whether there's a planner harness wrapping it.

Wire format (both topologies): LangChain native SSE — the format LangServe
produces by default:

    event: token
    data: {"text": "Hello"}

    event: tool_call
    data: {"tool_name": "increment", "tool_input": {}, "tool_call_id": "..."}

    event: message
    data: {"content": ""}

The `langchainAdapter` in packages/server/src/adapters/langchain.ts is
designed to consume exactly this shape and translate it to AI SDK v6.

TOOL RESULTS ARE EMITTED. This note used to say LangChain SSE "has no
first-class tool_end event — tool outputs are folded back into the agent loop
and surface as later token frames", and treated that as a reason not to send
one. It was a statement about the LangServe SSE *convention*, not about what is
available: `astream_events(version="v2")` yields `on_tool_end` for these tools
regardless of what the convention has a name for.

The cost of believing it was that every tool card in the UI sat on "pending"
forever — for tools that had finished, whose results the model had already used
to answer.
"""

import json
from typing import List

from langchain.agents import create_agent
from langchain_core.prompts import ChatPromptTemplate
from pydantic import BaseModel, Field

from ._common import SYSTEM_PROMPT, TOOLS, langfuse_config, make_llm


# ---------------------------------------------------------------------------
# Topology 1: ReAct (LangChain 1.x create_agent)
# ---------------------------------------------------------------------------


_graph = None


def get_executor():
    """Lazy-init the LangChain agent graph.

    Named `get_executor` rather than `get_graph` to keep the public API stable
    across LangChain versions — callers don't need to know about the 1.x rename.
    """
    global _graph
    if _graph is None:
        _graph = create_agent(
            model=make_llm(),
            tools=TOOLS,
            system_prompt=SYSTEM_PROMPT,
            name="django-langchain-react",
        )
    return _graph


# ---------------------------------------------------------------------------
# Topology 2: Plan-Execute (custom harness — LC 1.x deprecated PlanAndExecuteAgentExecutor)
# ---------------------------------------------------------------------------


class _Plan(BaseModel):
    """Structured output for the planner — ordered list of atomic steps."""

    steps: List[str] = Field(
        description="Ordered, atomic steps to accomplish the user's request. "
        "Each step should be a single concrete action an executor agent can "
        "perform in one turn (e.g. 'call increment()')."
    )


_plan_executor = None
_planner = None


def get_plan_execute_executor():
    """The executor agent — same as ReAct's, just renamed for trace clarity."""
    global _plan_executor
    if _plan_executor is None:
        _plan_executor = create_agent(
            model=make_llm(),
            tools=TOOLS,
            system_prompt=SYSTEM_PROMPT,
            name="django-langchain-plan-execute-executor",
        )
    return _plan_executor


def get_planner():
    """The planner — a model-with-structured-output chain. No graph, no tools."""
    global _planner
    if _planner is None:
        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "You are a planner. Given a user request, produce a concise "
                    "ordered list of atomic steps the executor agent can perform. "
                    "Each step should be a single concrete action (e.g. "
                    "'call increment()'). Do not skip; do not add steps that "
                    "aren't needed.",
                ),
                ("user", "{input}"),
            ]
        )
        # `.with_config(run_name=...)` makes the chain show up in LangSmith as
        # "django-langchain-plan-execute-planner" instead of "RunnableSequence".
        _planner = (prompt | make_llm().with_structured_output(_Plan)).with_config(
            {"run_name": "django-langchain-plan-execute-planner"}
        )
    return _planner


# ---------------------------------------------------------------------------
# Wire-format helpers — both topologies emit LangChain SSE.
# ---------------------------------------------------------------------------


def _token_event(text: str) -> str:
    return f"event: token\ndata: {json.dumps({'text': text})}\n\n"


def _tool_call_event(tool_name: str, tool_input, tool_call_id: str) -> str:
    return (
        "event: tool_call\n"
        f"data: {json.dumps({'tool_name': tool_name, 'tool_input': tool_input, 'tool_call_id': tool_call_id})}\n\n"
    )


def _tool_result_event(tool_call_id: str, output) -> str:
    """The result of a tool call, keyed to the id its invocation carried.

    THE ID IS THE WHOLE THING. The client pairs input to output by
    `tool_call_id` alone; a mismatch does not error, it silently leaves the card
    pending. `on_tool_start` and `on_tool_end` carry the same `run_id`, so the
    pairing is free — it just has to be passed through.

    Output is coerced to text because the client renders it and a
    ToolMessage.content may be a list of content blocks.
    """
    if hasattr(output, "content"):
        output = output.content
    if isinstance(output, list):
        output = "".join(
            part.get("text", "") if isinstance(part, dict) else str(part)
            for part in output
        )
    elif not isinstance(output, str):
        output = json.dumps(output, default=str)
    return (
        "event: tool_end\n"
        f"data: {json.dumps({'tool_call_id': tool_call_id, 'output': output})}\n\n"
    )


def _message_terminator() -> str:
    return f"event: message\ndata: {json.dumps({'content': ''})}\n\n"


async def _stream_agent_events(graph, agent_input):
    """Emit LangChain SSE frames from a single create_agent run."""
    # This ONE site covers both langchain topologies — they share this helper.
    async for event in graph.astream_events(
        agent_input, version="v2", config=langfuse_config()
    ):
        kind = event.get("event")
        if kind == "on_chat_model_stream":
            chunk = event["data"]["chunk"]
            content = getattr(chunk, "content", None)
            if isinstance(content, str) and content:
                yield _token_event(content)
        elif kind == "on_tool_start":
            yield _tool_call_event(
                event.get("name", "unknown"),
                event.get("data", {}).get("input", {}),
                event.get("run_id", ""),
            )
        elif kind == "on_tool_end":
            yield _tool_result_event(
                event.get("run_id", ""),
                event.get("data", {}).get("output"),
            )


# ---------------------------------------------------------------------------
# Topology dispatch
# ---------------------------------------------------------------------------


async def stream_chat_react(messages):
    """ReAct topology — single create_agent invocation."""
    async for chunk in _stream_agent_events(
        get_executor(), {"messages": messages}
    ):
        yield chunk
    yield _message_terminator()


async def stream_chat_plan_execute(messages):
    """Plan-Execute topology — planner produces steps, executor runs each.

    Wire emits a structured prelude (planning notice + the plan as text)
    before the executor runs. Each executor step's events are streamed
    inline. A single `event: message` terminator at the end closes the
    stream cleanly for the langchainAdapter.
    """
    user_text = messages[-1]["content"] if messages else ""

    # 1. Plan
    yield _token_event("Planning…\n")
    planner = get_planner()
    # THE ORPHAN. This planner call is NOT wrapped by any graph, so it inherits
    # nothing: wiring only the streaming sites above would leave the plan-execute
    # planner untraced while /health reported the backend as traced.
    plan = await planner.ainvoke({"input": user_text}, config=langfuse_config())
    plan_summary = "Plan:\n" + "\n".join(
        f"  {i + 1}. {step}" for i, step in enumerate(plan.steps)
    )
    yield _token_event(plan_summary + "\n\n")

    # 2. Execute each step using the executor agent
    executor = get_plan_execute_executor()
    for i, step in enumerate(plan.steps):
        yield _token_event(f"Step {i + 1}: {step}\n")
        agent_input = {
            "messages": [
                {
                    "role": "user",
                    "content": (
                        f"Overall user request: {user_text}\n\n"
                        f"Your current sub-step: {step}\n\n"
                        "Use the available tools to actually perform the action. "
                        "Do not just describe — invoke the tool API."
                    ),
                }
            ]
        }
        async for chunk in _stream_agent_events(executor, agent_input):
            yield chunk
        yield _token_event("\n")

    # 3. Terminator
    yield _message_terminator()


# Public dispatch surface — main.py reads this to route by body.topology.
TOPOLOGIES = {
    "react": stream_chat_react,
    "plan-execute": stream_chat_plan_execute,
}

# Backward compat: external callers may still reference `stream_chat`.
stream_chat = stream_chat_react

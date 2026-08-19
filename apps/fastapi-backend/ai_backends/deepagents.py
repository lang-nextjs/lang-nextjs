"""DeepAgents AI backend — uses the `deepagents` library. Two topologies:

  - "react"        → `create_deep_agent(model, tools, system_prompt)`. The
                     library's default flavor: planning supervisor + write_todos
                     + virtual file system + main agent that uses tools directly.
  - "plan-execute" → `create_deep_agent(..., subagents=[planner, executor])`.
                     The library's idiomatic plan-execute: orchestrator delegates
                     plan generation to a `planner` subagent, then delegates each
                     step to an `executor` subagent (which has the tools).
                     Demonstrates deepagents' multi-agent design.

Both topologies emit AI SDK v6 wire format (text-start/text-delta/text-end,
tool-input-start/available, tool-output-available, finish). Paired with
`deepagentsAdapter` in packages/server/src/adapters/deepagents.ts.
"""

import json

from deepagents import create_deep_agent

from ._common import (
    RESEARCH_PROMPT,
    RESEARCH_TOOLS,
    SYSTEM_PROMPT,
    TOOLS,
    make_llm,
)


# ---------------------------------------------------------------------------
# Topology 1: ReAct (default deepagents)
# ---------------------------------------------------------------------------

_graph = None


def get_graph():
    """Lazy-init the deepagents graph. Called once per process at lifespan startup."""
    global _graph
    if _graph is None:
        # `name=` makes LangSmith trace lists show "fastapi-deepagents"
        # instead of the default "LangGraph" — distinguishes the 6 cells
        # at a glance in the trace dashboard.
        _graph = create_deep_agent(
            model=make_llm(),
            tools=TOOLS,
            system_prompt=SYSTEM_PROMPT,
            name="fastapi-deepagents-react",
        )
    return _graph


# ---------------------------------------------------------------------------
# Topology 2: Plan-Execute via subagents (deepagents idiom)
# ---------------------------------------------------------------------------

_plan_execute_graph = None


def get_plan_execute_graph():
    """Build the plan-execute deep agent. The orchestrator delegates plan
    generation to a `planner` subagent and step execution to an `executor`
    subagent (which has the increment/get_counter tools).

    Pattern: deepagents subagents are declared via the `subagents=` kwarg.
    The main agent is given a `task(subagent, description)` tool and decides
    when to delegate. The orchestrator's system prompt nudges it toward the
    plan-execute flow.
    """
    global _plan_execute_graph
    if _plan_execute_graph is None:
        planner_subagent = {
            "name": "planner",
            "description": (
                "Generates a step-by-step plan for the user's request as a "
                "numbered list. Does NOT execute any actions — only plans. "
                "Delegate planning to this subagent before any execution."
            ),
            "system_prompt": (
                "You are a planner. Given a user request, produce a concise "
                "numbered list of atomic steps that the executor subagent can "
                "perform. Do not call any tools yourself — your job is to plan.\n"
                "Each step should be a single concrete action (e.g. "
                "'call increment()', 'call get_counter()'). Output the plan as "
                "plain text with one step per line."
            ),
            "tools": [],
        }
        executor_subagent = {
            "name": "executor",
            "description": (
                "Executes a single step from the plan by calling the "
                "appropriate tool (increment, get_counter). Receives the step "
                "description as input. Delegate each step to this subagent."
            ),
            "system_prompt": (
                "You are an executor. You will receive a description of a "
                "single step to perform. Use the tools available (increment, "
                "get_counter) to actually perform the action. Do not just "
                "describe — invoke the tool API. Report what you did concisely."
            ),
            "tools": TOOLS,
        }

        orchestrator_prompt = SYSTEM_PROMPT + (
            "\n\nWhen the user makes a request:\n"
            "1. First delegate to the `planner` subagent via the task() tool "
            "to produce a step-by-step plan.\n"
            "2. Then for each step in the plan, delegate to the `executor` "
            "subagent via task() with that step's description.\n"
            "3. After all steps, summarize what was done in a brief final reply.\n"
            "Do NOT call increment/get_counter directly — always delegate to "
            "the executor subagent."
        )

        # Note: orchestrator gets NO direct tools — only access to the auto-injected
        # `task` tool (for delegation) and write_todos / file system. This forces
        # delegation to subagents instead of calling increment/get_counter
        # directly. Without this, the LLM tends to take the shortest path and
        # call increment itself, defeating the plan-execute pattern.
        _plan_execute_graph = create_deep_agent(
            model=make_llm(),
            tools=[],
            system_prompt=orchestrator_prompt,
            subagents=[planner_subagent, executor_subagent],
            name="fastapi-deepagents-plan-execute",
        )
    return _plan_execute_graph


# ---------------------------------------------------------------------------
# Wire-format helper (shared across topologies — both emit AI SDK v6 native)
# ---------------------------------------------------------------------------


async def _emit_ai_sdk_v6(graph, messages):
    """Translate a deepagents stream into AI SDK v6 wire frames.

    Uses `astream(stream_mode=["messages","updates"], subgraphs=True)` and
    filters by namespace -- the same pattern as the official deepagents CLI
    (libs/cli/deepagents_cli/textual_adapter.py:534-636 and
     libs/cli/deepagents_cli/non_interactive.py:426-440).

    Result:
      - Main-agent (orchestrator) text  -> text-delta frames (visible reasoning)
      - Main-agent tool calls           -> tool-input-start/available frames
      - Tool results (incl. task)       -> tool-output-available frames
      - Subagent internal text          -> DROPPED (nested ns filtered)

    Subagents are encapsulated workers: their reasoning is visible in
    LangSmith for debugging, but only their return value (carried by the
    parent's task() tool output) reaches the chat UI. ReAct topology has no
    subagents, so this filter is a no-op there.
    """
    text_counter = 0
    text_id = None
    in_text = False

    async def start_text():
        nonlocal text_counter, text_id, in_text
        text_counter += 1
        text_id = f"text-{text_counter}"
        in_text = True
        return f'data: {{"type":"text-start","id":"{text_id}"}}\n\n'

    async def end_text():
        nonlocal in_text
        if in_text and text_id:
            in_text = False
            return f'data: {{"type":"text-end","id":"{text_id}"}}\n\n'
        return ""

    from langchain_core.messages import ToolMessage

    seen_tool_call_ids: set[str] = set()
    tool_arg_buffers: dict = {}

    async for chunk in graph.astream(
        {"messages": messages},
        stream_mode=["messages", "updates"],
        subgraphs=True,
    ):
        if not isinstance(chunk, tuple) or len(chunk) != 3:
            continue
        namespace, mode, data = chunk
        if mode != "messages":
            continue
        # Only main-agent (orchestrator) messages reach the user. Subagent
        # text is intentionally hidden, matching the canonical deepagents CLI
        # (libs/cli/deepagents_cli/textual_adapter.py:633-636). Subagent
        # reasoning is visible in LangSmith for debugging; only the
        # subagent's return value (carried by the parent's task() tool
        # output) is shown in the chat UI.
        if namespace:
            continue
        if not isinstance(data, tuple) or len(data) != 2:
            continue
        message, _metadata = data

        # Tool result -- comes back as a ToolMessage with the matching
        # tool_call_id we emitted earlier.
        if isinstance(message, ToolMessage):
            close = await end_text()
            if close:
                yield close
            tool_id = getattr(message, "tool_call_id", "")
            content = message.content
            if isinstance(content, str):
                out_text = content
            elif isinstance(content, list):
                out_text = " ".join(
                    item.get("text", "") if isinstance(item, dict) else str(item)
                    for item in content
                )
            else:
                out_text = str(content)
            yield f'data: {{"type":"tool-output-available","toolCallId":"{tool_id}","output":{json.dumps(out_text)}}}\n\n'
            continue

        # AIMessageChunk -- iterate normalized content_blocks for text + tool calls.
        if not hasattr(message, "content_blocks"):
            continue
        for block in message.content_blocks:
            block_type = block.get("type")
            if block_type == "text":
                text = block.get("text", "")
                if text:
                    if not in_text:
                        yield await start_text()
                    yield f'data: {{"type":"text-delta","id":"{text_id}","delta":{json.dumps(text)}}}\n\n'
            elif block_type in {"tool_call", "tool_call_chunk"}:
                # Buffer args until parseable. Providers stream args
                # incrementally as JSON strings; wait for the complete dict.
                chunk_id = block.get("id")
                chunk_index = block.get("index")
                key = chunk_index if chunk_index is not None else chunk_id
                if key is None:
                    continue
                buf = tool_arg_buffers.setdefault(
                    key, {"name": None, "id": None, "args": None, "args_parts": []}
                )
                if (name := block.get("name")):
                    buf["name"] = name
                if chunk_id:
                    buf["id"] = chunk_id
                args_chunk = block.get("args")
                if isinstance(args_chunk, dict):
                    buf["args"] = args_chunk
                elif isinstance(args_chunk, str) and args_chunk:
                    buf["args_parts"].append(args_chunk)
                    buf["args"] = "".join(buf["args_parts"])

                if buf["name"] is None or buf["id"] is None:
                    continue
                parsed = buf["args"]
                if isinstance(parsed, str):
                    if not parsed:
                        continue
                    try:
                        parsed = json.loads(parsed)
                    except json.JSONDecodeError:
                        continue
                elif parsed is None:
                    continue
                if not isinstance(parsed, dict):
                    parsed = {"value": parsed}

                if buf["id"] in seen_tool_call_ids:
                    continue
                seen_tool_call_ids.add(buf["id"])
                close = await end_text()
                if close:
                    yield close
                tool_name_json = json.dumps(buf["name"])
                tool_id = buf["id"]
                yield f'data: {{"type":"tool-input-start","toolCallId":"{tool_id}","toolName":{tool_name_json}}}\n\n'
                yield f'data: {{"type":"tool-input-available","toolCallId":"{tool_id}","toolName":{tool_name_json},"input":{json.dumps(parsed)}}}\n\n'

    close = await end_text()
    if close:
        yield close
    yield 'data: {"type":"finish","finishReason":"stop"}\n\n'


# ---------------------------------------------------------------------------
# Topology dispatch
# ---------------------------------------------------------------------------


async def stream_chat_react(messages):
    """ReAct topology — default deepagents (planning supervisor + tools)."""
    async for chunk in _emit_ai_sdk_v6(get_graph(), messages):
        yield chunk


async def stream_chat_plan_execute(messages):
    """Plan-Execute topology — orchestrator delegates to planner + executor subagents."""
    async for chunk in _emit_ai_sdk_v6(get_plan_execute_graph(), messages):
        yield chunk


# ---------------------------------------------------------------------------
# Topology 3: DeepResearch — deep agent with web search (DuckDuckGo, no key)
# ---------------------------------------------------------------------------

_research_graph = None


def get_research_graph():
    """Lazy-init a deepagents research agent: planning + filesystem + web_search."""
    global _research_graph
    if _research_graph is None:
        _research_graph = create_deep_agent(
            model=make_llm(),
            tools=RESEARCH_TOOLS,
            system_prompt=RESEARCH_PROMPT,
            name="fastapi-deepagents-research",
        )
    return _research_graph


async def stream_chat_research(messages):
    """DeepResearch topology — searches the web, plans, and synthesizes."""
    async for chunk in _emit_ai_sdk_v6(get_research_graph(), messages):
        yield chunk


# Public dispatch — main.py reads this to route by body.topology.
TOPOLOGIES = {
    "react": stream_chat_react,
    "plan-execute": stream_chat_plan_execute,
    "deep-research": stream_chat_research,
}

# Backward compat: external callers may still reference `stream_chat`.
stream_chat = stream_chat_react

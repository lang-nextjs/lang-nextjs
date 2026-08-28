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
    langfuse_config,
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

    turn_usage = {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}
    async for chunk in graph.astream(
        {"messages": messages},
        stream_mode=["messages", "updates"],
        subgraphs=True,
        # Langfuse: a handler when configured, {} when not. This ONE site covers
        # all three deepagents topologies, which all funnel through here.
        config=langfuse_config(),
    ):
        if not isinstance(chunk, tuple) or len(chunk) != 3:
            continue
        namespace, mode, data = chunk
        if mode != "messages":
            continue
        # SUBAGENT PROSE IS HIDDEN; SUBAGENT TOOL CALLS ARE NOT.
        #
        # Hiding subagent TEXT is deliberate and stays — it matches the
        # canonical deepagents CLI (libs/cli/deepagents_cli/textual_adapter.py:
        # 633-636), the reasoning is in LangSmith, and the subagent's return
        # value already reaches the UI through the parent's task() output.
        #
        # DROPPING THEIR TOOL CALLS TOO WAS A DIFFERENT THING WEARING THE SAME
        # CLOTHES. A subagent tool call MUTATES SHARED STATE, and suppressing it
        # means the UI reports work it did not do and omits work it did.
        # Measured by the live tool matrix the first time it ran for real:
        #
        #   deepagents × plan-execute: reported 0 increment call(s) but the
        #   counter moved from 5 to 6. Tools seen: ["task"]
        #
        # The counter moved and the stream said nothing — the exact "state
        # changing behind the UI's back" case that suite exists to catch. Prose
        # is noise; a state change is not.
        subagent = bool(namespace)
        if not isinstance(data, tuple) or len(data) != 2:
            continue
        message, _metadata = data

        # WHAT THE TURN COST, ACCUMULATED AS IT STREAMS (#232).
        #
        # `usage_metadata` lands on the chunks the provider chooses to put it
        # on — for the OpenAI wire format that is a single final chunk, and only
        # when `stream_usage=True` was requested. Summed rather than
        # overwritten: a topology may make SEVERAL model calls in one turn
        # (plan-execute does), and the number a person wants is what the whole
        # turn cost, not what its last call did.
        usage = getattr(message, "usage_metadata", None)
        if isinstance(usage, dict):
            turn_usage["inputTokens"] += usage.get("input_tokens") or 0
            turn_usage["outputTokens"] += usage.get("output_tokens") or 0
            turn_usage["totalTokens"] += usage.get("total_tokens") or 0

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
                # Subagent prose stays hidden — see the note above.
                text = "" if subagent else block.get("text", "")
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
                # A NEW TOOL CALL AT A REUSED INDEX GETS A FRESH BUFFER.
                #
                # The buffer is keyed by `index`, and index restarts across
                # successive AI message chunks — so a second tool call can
                # land on the same key as the first. `setdefault` then merged
                # it into the previous call's state, and because `buf["id"]`
                # is only overwritten when a chunk carries one, the second
                # call kept the FIRST call's id. The dedupe below then saw a
                # familiar id and skipped the announcement entirely, while the
                # result was still emitted from another code path.
                #
                # Measured on "increment the counter twice": two calls, ONE
                # announced. The client received a tool-output-available for a
                # call it had never been told about, so the card had no name
                # and no input — it rendered as "tool".
                #
                # Reset only when the id demonstrably CHANGED. A chunk with no
                # id is a continuation of the call in progress and must keep
                # accumulating into it.
                buf = tool_arg_buffers.get(key)
                if buf is None or (
                    chunk_id and buf["id"] is not None and buf["id"] != chunk_id
                ):
                    buf = {"name": None, "id": None, "args": None, "args_parts": []}
                    tool_arg_buffers[key] = buf
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
                # A TOOL WITH NO ARGUMENTS IS STILL A TOOL CALL.
                #
                # These three branches used to `continue`, which drops the
                # ANNOUNCEMENT while the RESULT is still emitted later from a
                # different code path. The client then receives a
                # `tool-output-available` for a call it was never told about.
                #
                # Measured on "increment the counter twice": three calls, one
                # announced. The other two arrived as bare outputs, so their
                # cards had no name and no input — they rendered as "tool".
                #
                #   tool-input-start      id=04d2e186  toolName=increment
                #   tool-input-available  id=04d2e186  toolName=increment
                #   tool-output-available id=04d2e186
                #   tool-output-available id=f2cbcb32   <- never announced
                #   tool-output-available id=3f3dc5b4   <- never announced
                #
                # `increment` takes no parameters, so its arguments stream as
                # an empty string — and empty is not malformed. An absent
                # argument list means `{}`, which is what the model actually
                # sent. Only genuinely UNREADABLE args are still dropped: there
                # we have no idea what was called, and inventing `{}` would
                # claim the model passed nothing when it may have passed
                # something we failed to parse.
                parsed = buf["args"]
                if isinstance(parsed, str):
                    if not parsed.strip():
                        parsed = {}
                    else:
                        try:
                            parsed = json.loads(parsed)
                        except json.JSONDecodeError:
                            continue
                elif parsed is None:
                    parsed = {}
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
    # `totalUsage` on the finish frame is the shape AI SDK v6 already defines,
    # so nothing on the client needs to change to read it. Omitted entirely when
    # the provider reported nothing — a zeroed usage block is a claim that the
    # turn was free, which is the misreport this is meant to end.
    if turn_usage["totalTokens"] or turn_usage["outputTokens"]:
        yield (
            'data: {"type":"finish","finishReason":"stop","totalUsage":'
            + json.dumps(turn_usage)
            + '}\n\n'
        )
    else:
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


def warmup() -> None:
    """Eager-init so first-request latency and import errors surface at boot.

    EVERY topology is built here, not just react: list_tools reads the graph's
    own tool node (see _builtin_tools), and a lazy graph would make that read
    construct an agent — calling make_llm() — inside a read-only GET.

    Called by main.py's lifespan THROUGH _MODULES, so it disappears with this
    module when `pnpm eject` drops the rung. Do not call it by name from main.
    """
    get_graph()
    get_plan_execute_graph()
    get_research_graph()
    _assert_execute_not_runnable()


def _assert_execute_not_runnable() -> None:
    """Fail at boot if `execute` is advertised unavailable but could actually run.

    `available: False` in main.py's _builtin_tools() is an interim constant, and
    this is what stops it rotting: wire a real sandbox backend and this raises,
    forcing the flag to be derived (isinstance(backend, SandboxBackendProtocol))
    rather than guessed.

    Lives HERE, not in main.py, because it inspects this module's graph. In main
    it read `deepagents.get_graph()` by name and so raised NameError at boot once
    `pnpm eject` dropped this rung — taking the whole backend down with it.
    """
    # deepagents.backends re-exports BackendProtocol but NOT the sandbox
    # variant — it only lives on the submodule. This is the pip package,
    # not this module.
    from deepagents.backends.protocol import SandboxBackendProtocol

    backend = getattr(get_graph(), "_blazing_backend", None)
    if isinstance(backend, SandboxBackendProtocol):
        raise RuntimeError(
            "A sandbox backend is wired, but list_tools still reports "
            "execute.available=False. Derive the flag from the backend instead "
            "of the hardcoded constant in _builtin_tools()."
        )


def graph_for(topology: str):
    """The compiled graph for a topology, for callers that introspect it.

    EXISTS SO main.py NEED NOT NAME THIS MODULE. `list_tools` used to reach in
    here by name — `deepagents.get_plan_execute_graph`, and two more — inside an
    `if ai_backend == "deepagents"` branch. `pnpm eject` prunes the import and
    `_MODULES` but does not rewrite function bodies, so an ejected fork kept a
    branch referring to a module it no longer had: 3 undefined names, the same
    defect #79 fixed in `lifespan` surviving one function further down.

    Reachable only through the registry, so eject's existing pruning carries it
    for free — the reasoning the warmup block already records.
    """
    return {
        "plan-execute": get_plan_execute_graph,
        "deep-research": get_research_graph,
    }.get(topology, get_graph)()


def custom_tools(topology: str):
    """The non-builtin tools this backend runs for a topology.

    Paired with `graph_for`: the builtin sweep needs to know which names are
    already covered by the custom list, and only this module knows that
    `deep-research` swaps the set.
    """
    # RESEARCH_TOOLS / TOOLS, not _common.* — this module imports the NAMES from
    # ._common and never binds the module itself. Written the other way first;
    # the endpoint returned 500 immediately, which is how it was caught.
    return RESEARCH_TOOLS if topology == "deep-research" else TOOLS

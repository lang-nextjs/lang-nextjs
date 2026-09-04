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
    _pending_approval_parts,
    approval_saver,
    _pending_interrupts,
    approval_interrupt_on,
    approval_resume_command,
    approval_thread_config,
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
        # `name=` makes LangSmith trace lists show "django-deepagents"
        # instead of the default "LangGraph" — distinguishes the 6 cells
        # at a glance in the trace dashboard.
        _graph = create_deep_agent(
            model=make_llm(),
            tools=TOOLS,
            system_prompt=SYSTEM_PROMPT,
            name="django-deepagents-react",
        )
    return _graph


# ---------------------------------------------------------------------------
# THE APPROVAL GATE FOR THIS RUNG (#332 steps C4/C5).
#
# MEASURED AGAINST deepagents 0.7.11 BEFORE BUILDING, because #332's table was
# wrong for the rung below and being right here is not something to assume:
#
#   gated tool        0 effects at the pause, 1 interrupt, effect runs on resume
#   allowlisted tool  no pause, no interrupt, and the tool RAN -- the presence
#                     companion, without which "did not pause" is also satisfied
#                     by a tool that never executed
#
# `interrupt_on` takes the same {name: bool} map the langchain rung's middleware
# takes, so `approval_interrupt_on` needs no per-rung variant, and the per-tool
# granularity the request's policy expresses survives.
#
# THIS RUNG DOES NOT AUTHOR THE PAYLOAD, and that is the difference from
# langgraph. deepagents builds the interrupt itself -- action_requests paired by
# index with review_configs -- so it is carried through verbatim rather than
# constructed here. Measured identical to the langchain rung's, which is why
# ApprovalPauseSchema can be the one reader for all three.
#
# AND THE PAUSE GOES OUT AS AN AI SDK v6 PART, not an `event:` frame. This
# backend already speaks the client's wire format and `deepagentsAdapter` only
# strips messageId, so there is nothing downstream to convert an
# `event: approval_pending` -- a rung emitting one would put the pause on the
# wire in a shape no layer reads. That is the defect #332 step C2 measured on the
# langgraph rung, and the reason `_pending_approval_parts` exists beside
# `_pending_approval_events`.
# ---------------------------------------------------------------------------



def get_gated_react_graph():
    """Build this request's react agent, gated by the policy the dispatch parsed.

    Built fresh each call rather than cached: the policy is per-request, so a
    cached graph would serve the first request's allowlist to every later one.
    """
    return create_deep_agent(
        model=make_llm(),
        tools=TOOLS,
        system_prompt=SYSTEM_PROMPT,
        name="django-deepagents-react",
        interrupt_on=approval_interrupt_on(t.name for t in TOOLS),
        checkpointer=approval_saver(__name__),
    )


def approval_thread_holds_a_pause(config) -> bool:
    """Does this thread still hold the interrupt a decision would answer? (#399)

    THE DISPATCH CALLS THIS BY NAME ON WHICHEVER MODULE IT ROUTED TO, so arming a
    rung without defining it is an AttributeError on the decisions path and only
    there -- a first message in a gated topology never reaches it, so the suite
    stays green and the first person to approve anything gets a 500.

    A LOST THREAD AND A NEVER-RUN THREAD READ IDENTICALLY HERE -- both hold zero
    interrupts -- so this is only half a predicate. The dispatch supplies the
    other half by asking it only when decisions were actually sent.
    """
    return bool(_pending_interrupts(get_gated_react_graph(), config))


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
            name="django-deepagents-plan-execute",
        )
    return _plan_execute_graph


# ---------------------------------------------------------------------------
# Wire-format helper (shared across topologies — both emit AI SDK v6 native)
# ---------------------------------------------------------------------------


async def _emit_ai_sdk_v6(graph, agent_input, thread=None):
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
        # THE INPUT IS THE CALLER'S, NOT ALWAYS A MESSAGE LIST. A resume is a
        # Command that RE-ENTERS a paused graph; wrapping it in {"messages": ...}
        # would start a fresh turn wearing a decision's clothes, leaving the
        # pending tool call pending (#332 step C4).
        agent_input,
        stream_mode=["messages", "updates"],
        subgraphs=True,
        # Langfuse: a handler when configured, {} when not. This ONE site covers
        # all three deepagents topologies, which all funnel through here.
        #
        # MERGED WITH THE THREAD, NOT CHOSEN BETWEEN. langfuse_config() carries the
        # callbacks and metadata; a gated run adds configurable.thread_id. Picking
        # one runs every gated turn untraced while /health reports the backend as
        # traced — measured on the langgraph rung, which shipped exactly that.
        config={**langfuse_config(), **(thread or {})},
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
        # Summed rather than overwritten: a topology may make SEVERAL model
        # calls in one turn (plan-execute does), and the number a person wants
        # is what the whole turn cost, not what its last call did.
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
                # successive AI message chunks — so a second tool call can land
                # on the same key as the first. `setdefault` then merged it into
                # the previous call's state, and because `buf["id"]` is only
                # overwritten when a chunk carries one, the second call kept the
                # FIRST call's id. The dedupe below saw a familiar id and
                # skipped the announcement entirely.
                #
                # Fixed on the fastapi plane earlier; this plane kept the defect,
                # and it is why `increment` never reached the client here. The
                # main agent calls `task` first, so the subagent's `increment`
                # IS the second call — measured: counter moved 1, stream
                # reported 0.
                #
                # Reset only when the id demonstrably CHANGED. A chunk with no
                # id is a continuation of the call in progress and must keep
                # its buffer.
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
    # WHERE THE NUMBER GOES IS NOT A STYLE CHOICE (#714). AI SDK v6 builds the
    # UI-message chunk union out of `z.strictObject()`, so the `finish` branch
    # accepts exactly `type`, `finishReason` and `messageMetadata`. An extra key
    # does not degrade the frame — it REJECTS it, and because `finish` is the
    # terminal frame the client discards the WHOLE TURN and shows a validation
    # wall instead of the answer. `totalUsage` at the top level is the SDK's
    # onFinish/StepResult CALLBACK shape, not the wire chunk; the two share a
    # name, which is how this shipped believing it was "the shape AI SDK v6
    # already defines". `messageMetadata` is the branch's own extension point
    # and is typed `unknown`, so the number rides through untouched.
    #
    # The contract is asserted against the SDK's real schema by
    # packages/test-utils/src/finish-frame-conformance.test.ts, and the shape
    # emitted here against the contract by this plane's own wire-format test.
    #
    # Omitted entirely when the provider reported nothing — a zeroed usage block
    # is a claim that the turn was free, which is the misreport this is meant to
    # end.
    #
    # ANY FIELD, NOT JUST THE TWO (#734). This read `totalTokens or outputTokens`
    # and never consulted `inputTokens`, which was accumulated two lines above and
    # read by nothing — so a turn that bought 100 tokens of context and produced no
    # output reported as free. That is the misreport the sentence above already
    # rules out, arriving by a route the predicate did not cover: 100 input tokens
    # is emphatically not "the provider reported nothing".
    #
    # `any()` states the rule that comment states, rather than a narrower one that
    # happens to agree with it on the cases anybody had tried. It keeps
    # `zeros-are-not-a-report` red-if-broken, because all-zero is still nothing —
    # and that pair is what separates "report a turn the provider measured" from
    # "always report", which is the repair a reader reaches for first.
    if any(turn_usage.values()):
        yield (
            'data: {"type":"finish","finishReason":"stop","messageMetadata":'
            '{"totalUsage":'
            + json.dumps(turn_usage)
            + '}}\n\n'
        )
    else:
        yield 'data: {"type":"finish","finishReason":"stop"}\n\n'


# ---------------------------------------------------------------------------
# Topology dispatch
# ---------------------------------------------------------------------------


async def stream_chat_react(messages):
    """ReAct topology — default deepagents (planning supervisor + tools)."""
    # THE DECLARATION DECIDES BOTH ENDS: the dispatch reads GATED_TOPOLOGIES to
    # know whether to demand a policy, and this reads the same constant to know
    # whether to build a gated graph. Deciding independently is how the two come
    # to disagree.
    gated = "react" in GATED_TOPOLOGIES
    graph = get_gated_react_graph() if gated else get_graph()
    thread = approval_thread_config() if gated else {}
    # A RESUME RE-ENTERS THE GRAPH; IT DOES NOT START A TURN. Passing the messages
    # again would append the user's text a second time and run the model afresh,
    # leaving the pending call pending.
    resume = approval_resume_command() if gated else None
    agent_input = resume if resume is not None else {"messages": messages}
    async for chunk in _emit_ai_sdk_v6(graph, agent_input, thread=thread):
        yield chunk

    # AFTER THE STREAM DRAINS, NOT DURING. An interrupted run ends its event
    # stream normally -- no event names the pause -- so the state can only be
    # asked once the iteration is done.
    if gated:
        for frame in _pending_approval_parts(graph, thread):
            yield frame


async def stream_chat_plan_execute(messages):
    """Plan-Execute topology — orchestrator delegates to planner + executor subagents."""
    async for chunk in _emit_ai_sdk_v6(get_plan_execute_graph(), {"messages": messages}):
        yield chunk


# ---------------------------------------------------------------------------
# Topology 3: DeepResearch (planning + filesystem + web search)
#
# Ported from the FastAPI backend so `deepagents × django` offers the same
# three topologies as `deepagents × fastapi`. Previously deep-research existed
# in exactly one (rung, runtime) pair, which the UI had to special-case.
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
            name="django-deepagents-research",
        )
    return _research_graph


async def stream_chat_research(messages):
    """DeepResearch topology — searches the web, plans, and synthesizes."""
    async for chunk in _emit_ai_sdk_v6(get_research_graph(), {"messages": messages}):
        yield chunk


# Public dispatch — views.py reads this to route by body.topology.
# WHICH TOPOLOGIES ENFORCE APPROVAL, stated rather than discovered (#332).
#
# EMPTY, AND THAT IS THE CURRENT TRUTH RATHER THAN AN OVERSIGHT. Only
# langchain x react has been moved to an upstream gate so far; the rest still
# rely on the proxy-side transform, which withholds the REPORT and not the
# effect (#256). Written down so a reader finds a stated position instead of an
# absence, and so this file is where the next cell gets added.
GATED_TOPOLOGIES = frozenset({"react"})

TOPOLOGIES = {
    "react": stream_chat_react,
    "plan-execute": stream_chat_plan_execute,
    "deep-research": stream_chat_research,
}

# Backward compat: external callers may still reference `stream_chat`.
stream_chat = stream_chat_react

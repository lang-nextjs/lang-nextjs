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
from langchain.agents.middleware import HumanInTheLoopMiddleware
from langgraph.checkpoint.memory import InMemorySaver
from langchain_core.prompts import ChatPromptTemplate
from pydantic import BaseModel, Field

from ._common import (
    SYSTEM_PROMPT,
    TOOLS,
    approval_interrupt_on,
    approval_thread_config,
    approval_resume_command,
    langfuse_config,
    make_llm,
)


# ---------------------------------------------------------------------------
# Topology 1: ReAct (LangChain 1.x create_agent)
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# THE GATED GRAPH IS BUILT PER REQUEST, AND IS DELIBERATELY NOT CACHED (#261).
#
# `_graph` below stays a process-wide singleton for the UNGATED path. The gated
# one cannot be: its `interrupt_on` comes from the request's own policy, so a
# cached graph would gate by whatever policy happened to build it first.
#
# A POLICY-KEYED CACHE WAS PROPOSED AND REJECTED ON A MEASUREMENT. Steady state,
# 200 iterations after 20 discarded warm-ups, real model and middleware:
#
#     ungated   median  3.32 ms    p95  86.93 ms
#     gated     median 11.63 ms    p95 120.31 ms
#
# That is ~12ms in front of a request that then streams from a model for
# seconds. The p95 is allocation pressure from building 200 graphs back to
# back, which a server doing one per request does not have.
#
# AND THE CACHE'S FAILURE MODES ARE WORSE THAN THE 12ms, which is the actual
# argument rather than the cost:
#
#   * KEY COLLISION. The natural key is a hash of the allowlist. Two allowlists
#     colliding hands a request a graph gated by someone ELSE's policy, and it
#     fails silently in the PERMISSIVE direction whenever that other policy is
#     more permissive — a gate enforcing a decision nobody made, which is #256
#     wearing a different hat.
#   * UNBOUNDED KEY SPACE, CHOSEN BY THE CLIENT. The allowlist arrives in the
#     request. A caller varying it per request — a fuzzer, a bug, or MCP tool
#     names that differ per session — mints a graph every time and nothing
#     evicts them. A cache keyed by client input is a memory leak whose rate
#     the client sets.
#   * Bounding it with an LRU fixes the leak, reintroduces collisions under
#     pressure, and adds a third failure: eviction between a pause and its
#     resume.
#
# If a later measurement ever shows construction dominating a real request, the
# shape is an LRU keyed by the allowlist WITH AN EXPLICIT BOUND — but beat the
# number above first rather than re-deriving this.
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
            name="fastapi-langchain-react",
        )
    return _graph


# ONE SAVER FOR THE PROCESS, NOT ONE PER REQUEST. A per-request InMemorySaver
# makes resume impossible by construction: the decision arrives on a LATER
# request, finds an empty saver, and every approval becomes the lost-checkpoint
# case measured in #401 — which we accepted only because it is rare and
# documented. Per-request would have made it universal without anyone deciding
# that.
_APPROVAL_SAVER = InMemorySaver()


def get_gated_executor():
    """Build this request's agent, gated by the policy the dispatch parsed.

    Built fresh each call — see the note above `_graph` for the measurement
    that says not to cache it.
    """
    return create_agent(
        model=make_llm(),
        tools=TOOLS,
        system_prompt=SYSTEM_PROMPT,
        name="fastapi-langchain-react",
        middleware=[
            HumanInTheLoopMiddleware(
                interrupt_on=approval_interrupt_on(t.name for t in TOOLS)
            )
        ],
        checkpointer=_APPROVAL_SAVER,
    )



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
            name="fastapi-langchain-plan-execute-executor",
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
        # "fastapi-langchain-plan-execute-planner" instead of the default
        # "RunnableSequence" — distinguishes the planner sub-run from other
        # generic chains in the trace dashboard.
        _planner = (prompt | make_llm().with_structured_output(_Plan)).with_config(
            {"run_name": "fastapi-langchain-plan-execute-planner"}
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


def _pending_approval_events(graph, config):
    """Frames for any approval the run is now waiting on. Empty when it is not.

    ── THE SHAPE OF THESE FRAMES IS PROVISIONAL AND #420 OWNS IT ──────────────
    #
    # Nothing may depend on this layout yet: no client renders it, no resume path
    # parses it, and the tests assert that the DECISIONS AND THE ACTION REQUESTS
    # SURVIVE THE CROSSING rather than that any field sits where it sits today. A
    # shape that ships unmarked becomes the contract by nobody deciding, which is
    # how `pythonBackend` survived long enough to need #360.
    #
    # WHY A FRAME AT ALL, NOW. Without one a gated request returns 200, one empty
    # message frame, and silence — the tool correctly withheld and the person told
    # nothing. That is an action whose outcome is not reported, which is the defect
    # this whole change exists to remove, so the gate cannot be armed until this
    # exists (#413 ships disarmed for exactly this reason).
    #
    # ── WHY IT IS READ FROM STATE AND NOT FROM THE EVENT STREAM ───────────────
    #
    # `astream_events` yields only chain and model events for an interrupted run —
    # measured: on_chain_start/stream/end and on_chat_model_start/end, and nothing
    # naming the interrupt. The pause is on the graph state instead, so it is read
    # after the stream drains rather than intercepted mid-flight.
    #
    # ── CARRIED FAITHFULLY, NOT TRANSLATED ────────────────────────────────────
    #
    # `action_requests` and `allowed_decisions` are passed through as upstream
    # wrote them. The four-way vocabulary is LangChain's own, not ours to narrow
    # here: #332 established that `approve/edit/reject/respond` is upstream's
    # verbatim, and translating it at this boundary would decide #420 by accident
    # in the direction of whatever the client happened to accept.
    """
    try:
        state = graph.get_state(config)
    except Exception:
        # A graph with no checkpointer cannot be asked, and that is not an error
        # here — it means this run was never gated. Returning nothing is the
        # honest answer; raising would turn an ungated run into a failed one.
        return []

    frames = []
    for task in getattr(state, "tasks", ()) or ():
        for interrupt in getattr(task, "interrupts", ()) or ():
            payload = getattr(interrupt, "value", None)
            if not isinstance(payload, dict):
                continue
            frames.append(
                "event: approval_pending\n"
                f"data: {json.dumps({'interrupt': payload}, default=str)}\n\n"
            )
    return frames


def approval_thread_holds_a_pause(config) -> bool:
    """Does this thread still hold the interrupt a decision would answer? (#399)

    THE SAME READER THE EMITTER USES, deliberately. `_pending_approval_events` is
    what tells the client a call is pending; asking a second question a second way
    is how "the card says pending" and "the backend thinks it is pending" come to
    disagree, and this function exists precisely to catch a disagreement.

    WHY THIS QUESTION IS ASKED BEFORE THE RESUME AND NOT AFTER. Measured on #399:
    a decision arriving for a thread the saver no longer holds does NOT raise and
    does NOT re-pause. The graph runs a full chain to completion, executes nothing,
    and emits zero approval_pending frames -- a clean 200 whose only distinguishing
    feature is the ABSENCE of tool frames, which is indistinguishable from a turn
    where the model simply chose not to call a tool. There is nothing to notice
    afterwards, so the only moment a refusal is expressible is before the stream
    starts and while the response status is still ours to choose.

    A LOST THREAD AND A NEVER-RUN THREAD READ IDENTICALLY HERE -- both hold zero
    interrupts -- so this is only half a predicate. The caller supplies the other
    half by asking it ONLY when decisions were actually sent; an ordinary turn is
    never judged, which is why this cannot refuse a normal message.
    """
    return bool(_pending_approval_events(get_gated_executor(), config))


async def _stream_agent_events(graph, agent_input, config=None):
    """Emit LangChain SSE frames from a single create_agent run."""
    # THE EXECUTOR, IN BOTH TOPOLOGIES — AND NOT THE PLANNER. This note used to
    # say "this ONE site covers both langchain topologies", which is true of the
    # executor and false of the plan-execute planner, and the difference is the
    # whole reason `stream_chat_plan_execute` calls `planner.ainvoke(...)`
    # instead of streaming it: the planner is a `with_structured_output` chain,
    # so streaming it puts the raw JSON of the Plan object on the wire as
    # `event: token`. Every frame would be well-formed and the adapter would
    # accept all of it; the user would read a serialised object where a plan
    # should be. Same defect langgraph.py spends `_STRUCTURED_OUTPUT_NODES` on.
    #
    # Written down because the protection here is an ABSENCE — there is no
    # filter to copy and no constant to forget, so a port reading this file for
    # "what must I reproduce" finds nothing at the planner, and the idiomatic
    # answer, reusing this helper, is the broken one. It happened: #8.
    # MERGED, NOT REPLACED. langfuse_config() carries callbacks and metadata; the
    # gated path adds `configurable.thread_id`. Passing either alone drops the
    # other, and dropping the callbacks is silent — this file already records that
    # an empty callbacks list REPLACES inherited ones on nested runs. The two dicts
    # share no keys, so a shallow merge is the whole of it.
    async for event in graph.astream_events(
        agent_input,
        version="v2",
        config={**langfuse_config(), **(config or {})},
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
    # THE GATED BUILDER, and the thread the decision will come back on. Both come
    # from the dispatch: it parsed the policy and named the thread, because it is
    # the only place that sees the request.
    # THE DECLARATION DECIDES BOTH ENDS. The dispatch reads GATED_TOPOLOGIES to know
    # whether to demand a policy; this reads the same constant to know whether to build a
    # gated graph. Choosing here independently is how the two come to disagree — the
    # declaration says gated and the topology builds ungated, or the reverse, and nothing
    # compares them. A presence companion caught exactly that: with react removed from the
    # set, this still called the gated builder and died on a policy the dispatch had
    # correctly not parsed.
    gated = "react" in GATED_TOPOLOGIES
    graph = get_gated_executor() if gated else get_executor()
    config = approval_thread_config() if gated else None
    # A RESUME RE-ENTERS THE GRAPH; IT DOES NOT START A TURN. Passing the messages
    # again would append the user's text a second time and run the model afresh,
    # which is a new turn wearing a decision's clothes — the pending tool call would
    # still be pending and the approval would have done nothing.
    resume = approval_resume_command() if gated else None
    agent_input = resume if resume is not None else {"messages": messages}
    async for chunk in _stream_agent_events(graph, agent_input, config=config):
        yield chunk

    # AFTER THE STREAM DRAINS, NOT DURING. An interrupted run ends its event stream
    # normally — there is no event naming the pause — so the only moment the state can
    # be asked is once the iteration is done. Held as `graph` rather than rebuilt,
    # because a second get_gated_executor() would be a different object with the same
    # checkpointer and this would be reading a graph that never ran.
    if gated:
        for frame in _pending_approval_events(graph, config):
            yield frame

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
# WHICH TOPOLOGIES ENFORCE APPROVAL, stated rather than discovered (#332).
#
# The dispatch reads this to decide whether a request needs a sessionId, so an
# omission here is not a style problem — it silently makes a topology ungated
# while the client still renders an approval card for it. Accessed as a plain
# attribute rather than with getattr(..., default): a module that forgets it
# should crash on the first request, not quietly gate nothing.
# ARMED FOR `react`, ON THIS PLANE ONLY (#332 step B).
#
# This was empty on purpose. The condition recorded here was "add react back once the
# pause is surfaced and answerable", because arming it earlier would have replaced "the
# tool runs and the card lies about having gated it" with "nothing happens and nobody is
# told" -- both wrong, and the second is an action whose outcome is not reported.
#
# THAT CONDITION IS NOW MET, and it is met by things that exist rather than by a plan:
# the backend reads get_state() after the stream and emits `approval_pending`; the
# adapter re-labels it `data-approval-pause`, deliberately not adjacent to the
# non-withholding `data-approval-required`; ApprovalPauseCard renders it and offers
# exactly the payload's `allowed_decisions`; and the resume route delivers the answer
# back as Command(resume=...), after which the tool runs -- asserted in
# test_approval_withholds.py.
#
# ONE TOPOLOGY, ONE PLANE, DELIBERATELY. Five more declarations stay frozenset(). This is
# the step where the gate stops being a mechanism and starts being behaviour a user meets,
# and #449's two-gate stacking stops being latent; a change that armed six at once would
# make a first failure six times harder to attribute.
#
# WHAT WOULD MAKE ARMING WRONG AGAIN: the pause ceasing to reach a person. That is not a
# judgement call left to a reader -- test_the_SHIPPED_configuration_gates_react below runs
# through the dispatch with no monkeypatch, so if the surfacing breaks, this line is what
# goes red.
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
    get_executor()

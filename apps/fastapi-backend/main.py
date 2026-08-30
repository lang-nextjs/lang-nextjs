"""FastAPI entrypoint — dispatches to one of three AI backends per route.

Each AI backend lives in `ai_backends/{deepagents,langgraph,langchain}.py` and
owns its own (agent framework, wire format) pair. This module is a thin router
that picks the right `stream_chat` async generator and wraps the response.

Routes:
  GET  /health                       — liveness probe
  POST /api/chat/stream/{ai_backend} — chat stream, ai_backend ∈ {deepagents,langgraph,langchain}

The Next.js proxy at `/api/chat/stream` receives `aiBackend` in its body and
forwards to the matching path here. Each backend's wire format is normalized
client-side by the matching adapter in packages/server/src/adapters/.
"""

import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from ai_backends import _common, deepagents, langchain, langgraph

load_dotenv(".env.local")


# Each AI backend module exposes TOPOLOGIES = {"react": stream_chat, ...}.
# The matrix is now (python × ai × topology) — three axes. Dispatch picks
# the right async generator from the right module.
_MODULES = {
    "deepagents": deepagents,
    "langgraph": langgraph,
    "langchain": langchain,
}

DEFAULT_TOPOLOGY = "react"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Eager-init each AI backend so first request latency stays low and
    # any import / agent-construction errors surface at startup, not on hit.
    #
    # Warm up THROUGH THE REGISTRY, never by naming modules literally.
    #
    # This block used to call deepagents.* and langgraph.* by name. `pnpm eject`
    # prunes the import list and _MODULES but does not rewrite function bodies,
    # so after `eject langchain` those names were gone and the app died at boot
    # with `NameError: name 'deepagents' is not defined` — the whole backend,
    # not one rung. Nothing caught it: the severability Python plane is the only
    # thing that executes this file, and it had never once passed.
    #
    # Driving warmup off _MODULES means eject's existing pruning carries the
    # eager-init for free, and a future rung needs no change here at all.
    for ai, mod in _MODULES.items():
        warm = getattr(mod, "warmup", None)
        if warm is None:
            continue
        warm()
    topologies = {
        ai: list(mod.TOPOLOGIES) for ai, mod in _MODULES.items()
    }
    print(f"FastAPI ready: ai_backends={list(_MODULES)} topologies={topologies}")
    yield


def _cors_allowed_origins() -> list[str]:
    """The CORS allowlist, from the environment, defaulting to the DEV origins.

    FOLLOWS THE `DJANGO_SECRET_KEY` PRECEDENT three files over: a dev default,
    an environment override, and a name that says which it is (#349). CORS was
    the one value in this repo with a dev default and NO override — and it is
    the one that silently keeps working in production when it is wrong, which
    is the opposite of the ordering you would choose.

    EMPTY MEANS EMPTY. `CORS_ALLOWED_ORIGINS=""` allows nothing; only an UNSET
    variable falls back to the dev list. An operator who deliberately empties an
    allowlist and silently gets the developer's laptop back would have no way to
    express what they meant.

    The default list is declared once in scripts/fixtures/cors-origins.json and
    scripts/check-cors-parity.mjs asserts all three backends still agree with
    it — before that file the copies had already drifted, with django missing
    http://localhost:3000 that the other two allowed.
    """
    raw = os.environ.get("CORS_ALLOWED_ORIGINS")
    if raw is None:
        return [
            "http://localhost:3000",
            "http://localhost:3001",
            "http://localhost:3002",
            "http://frontend:3001",
            "http://frontend:3002",
        ]
    return [o.strip() for o in raw.split(",") if o.strip()]


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_allowed_origins(),
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "ai_backends": list(_MODULES),
        "topologies": {
            ai: list(mod.TOPOLOGIES) for ai, mod in _MODULES.items()
        },
        # Presence only, never the key. The UI's readiness indicator needs to
        # know whether a model is reachable BEFORE the first send, and this is
        # the process that builds it.
        "llm": _common.llm_status(),
        # Which tracing integrations are ON, not merely keyed. See the
        # helper: langfuse keys present still means no spans are sent.
        "observability": _common.observability_status(),
    }


@app.post("/api/chat/stream")
async def chat_stream_legacy(request: Request):
    """Legacy single-backend endpoint — defaults to deepagents + react.

    Preserved for backward compatibility with single-backend deployments and
    the existing E2E test suite (which posts to /api/chat/stream without a
    body.aiBackend field). New code should use /api/chat/stream/{ai_backend}
    with body.topology to pick a non-default topology.
    """
    return await chat_stream("deepagents", request)


# DeepAgents injects its builtins via create_deep_agent middleware (not in the
# tools list we pass), so we surface them for the UI. We READ them off the
# compiled graph rather than hand-listing them: a hand-written list is a manual
# sync point that silently desyncs. The one this replaced had already lost
# `glob` and `grep`, and advertised `execute` as "(sandboxed)" while the
# configured backend could not execute at all.
#
# create_deep_agent merges the tools we pass into the same ToolNode as its
# builtins, so the node yields OUR tools too (react: 11 entries, not 9). They
# are excluded here because list_tools already reports them from _common.TOOLS
# — including them would emit each one twice, once mislabelled "builtin".


def _builtin_tools(graph, custom_names: set[str]) -> list[dict]:
    """DeepAgents' middleware-injected builtins, read from the live graph."""
    tools_node = graph.nodes["tools"]
    by_name = getattr(getattr(tools_node, "bound", tools_node), "tools_by_name", {}) or {}
    return [
        {
            "name": t.name,
            "description": (t.description or "").split("\n")[0],
            "source": "builtin",
            # `execute` is real — deepagents' SandboxBackendProtocol defines it —
            # but it can only run when a sandbox backend is passed to
            # create_deep_agent(backend=...). We pass none, so the default
            # StateBackend (a virtual filesystem with no execute()) is in force.
            # Hardcoded because the backend is not reachable from here; the
            # startup assertion below fails the moment that stops being true.
            **({"available": False} if t.name == "execute" else {}),
        }
        for name, t in by_name.items()
        if name not in custom_names
    ]


@app.get("/api/tools/{ai_backend}")
async def list_tools(ai_backend: str, topology: str = DEFAULT_TOPOLOGY):
    """Introspect the tools + MCP servers wired for a given (ai_backend, topology).

    Lets the UI show the agent's real capabilities. MCP servers are read from the
    MCP_SERVERS env (comma-separated names); none configured → empty list.
    """
    if ai_backend not in _MODULES:
        raise HTTPException(status_code=404, detail=f"unknown ai_backend {ai_backend!r}")

    def describe(tools):
        return [
            {"name": t.name, "description": (t.description or "").split("\n")[0], "source": "custom"}
            for t in tools
        ]

    tools: list[dict] = []
    # THROUGH THE REGISTRY, NEVER BY NAME — the rule the warmup block above
    # already states, applied here too. This branch used to be
    # `if ai_backend == "deepagents":` with three literal `deepagents.*`
    # references, so `pnpm eject langchain` produced a fork whose main.py named
    # a module it had just removed. Measured with ruff F821 on the ejected
    # tree: 3 undefined names for langchain, 3 for langgraph.
    #
    # KEYED ON A DECLARED CAPABILITY, NOT ON `getattr(mod, "get_graph")`.
    # langgraph also defines `get_graph`, so probing for it would have silently
    # started expanding builtins for a backend that had never reported any —
    # a behaviour change wearing a refactor's clothes. Only DeepAgents injects
    # builtins through middleware, which is why only it defines `graph_for`.
    mod = _MODULES[ai_backend]
    graph_for = getattr(mod, "graph_for", None)
    if graph_for is not None:
        custom = getattr(mod, "custom_tools", lambda _t: _common.TOOLS)(topology)
        tools.extend(_builtin_tools(graph_for(topology), {t.name for t in custom}))
        tools.extend(describe(custom))
    else:
        tools.extend(describe(_common.TOOLS))

    mcp_env = os.environ.get("MCP_SERVERS", "").strip()
    mcps = [s.strip() for s in mcp_env.split(",") if s.strip()]

    return {"ai_backend": ai_backend, "topology": topology, "tools": tools, "mcps": mcps}


@app.post("/api/chat/stream/{ai_backend}")
async def chat_stream(ai_backend: str, request: Request):
    module = _MODULES.get(ai_backend)
    if module is None:
        raise HTTPException(
            status_code=404,
            detail=f"unknown ai_backend {ai_backend!r}; expected one of {list(_MODULES)}",
        )
    body = await request.json()
    topology = body.get("topology") or DEFAULT_TOPOLOGY
    stream_fn = module.TOPOLOGIES.get(topology)
    if stream_fn is None:
        raise HTTPException(
            status_code=404,
            detail=f"unknown topology {topology!r} for ai_backend {ai_backend!r}; "
            f"expected one of {list(module.TOPOLOGIES)}",
        )
    messages = body.get("messages", [])
    user_text = messages[-1].get("content", "") if messages else ""
    input_messages = [{"role": "user", "content": user_text}]

    # THE THREAD, REQUIRED ONLY WHERE THE GATE IS REAL (#261).
    #
    # SCOPED TO GATED TOPOLOGIES DELIBERATELY. An ungated topology with no
    # sessionId keeps working exactly as it did: making every request carry one
    # would be a far larger contract break than this change is, and a broad
    # outage sold as a safety fix.
    #
    # WHY REFUSE RATHER THAN GATE UN-RESUMABLY. A gate with no thread pauses a
    # call the user can never approve — which is not merely LIKE #399, it
    # manufactures new instances of it while that fix is being written.
    # Inheriting a defect and choosing one are different things. It is also a
    # genuine edge case: sessionId already arrives on the normal path and is
    # used for tracing, so this fires where a client is malformed, not where a
    # user is working.
    if topology in module.GATED_TOPOLOGIES:
        # THE POLICY IS REQUIRED HERE TOO, AND ONLY HERE.
        #
        # An absent policy is not "nothing is dangerous" — it is a question nobody
        # answered, and a gate built from it reports having considered something it
        # never considered.
        #
        # SCOPED for the same reason the sessionId check is: apps/example has no
        # approval concept at all, so requiring a policy of every caller would take
        # a whole app down to protect topologies that do not gate. A caller whose
        # topology starts gating later has to send one then — and it will be told
        # so, by name, rather than silently running ungated.
        try:
            _common.set_approval_allowlist(_common.parse_approval_policy(body))
        except _common.ApprovalPolicyError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        session_id = body.get("sessionId")
        if not isinstance(session_id, str) or not session_id:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"no sessionId was named, and topology {topology!r} requires "
                    f"approval. A gated call is paused until someone answers it, and "
                    f"the answer arrives on a later request that has to find the same "
                    f"conversation — without a sessionId there is nothing to resume."
                ),
            )
        _common.set_thread_id(session_id)

    # WHAT THIS RUN IS, recorded once, here — the only place that knows.
    #
    # Traces arrived named `fastapi-deepagents-react`, so the axes were all
    # present and none of them was queryable: `tags: []`, and finding every
    # langgraph run meant substring-matching a trace name. These become
    # `framework:deepagents` / `topology:react` tags, which Langfuse filters
    # and groups on — so "every plan-execute run, across all frameworks" is a
    # click rather than a manual comparison.
    #
    # `runtime` is this process, not a request field: a Django deployment of
    # the same frameworks is what a person is comparing against, and it cannot
    # tell you so from here.
    # SESSION, NOW THAT ONE EXISTS (#171). Langfuse groups a conversation's
    # turns by `langfuse_session_id`, and until now nothing here could supply a
    # correct one: the client sent a HARDCODED "lang-nextjs-chat" for every
    # conversation and the route stripped it before it left. The available
    # values grouped either everything or nothing, and both are wrong in a way
    # that looks right on the screen.
    #
    # The client now sends the conversation id and the route forwards it, so
    # this is the real thing. STILL ABSENT WHEN ABSENT: set_run_axes drops
    # falsey values, so an older client that sends nothing produces a trace with
    # no session rather than one grouped under "None" — an absent axis and an
    # axis whose value is the string "None" are different facts.
    _common.set_run_axes(
        runtime="fastapi",
        framework=ai_backend,
        topology=topology,
        session=body.get("sessionId"),
    )

    # WRAPPED, NOT RAW. `StreamingResponse` flushes 200 before it iterates, so
    # an exception from `stream_fn` closes the socket with no terminal frame
    # and the proxy — correctly, from where it sits — calls that a mid-stream
    # disconnect. #247: a provider 410 saying the model had reached end of life
    # reached the user as "upstream backend disconnected mid-stream". This is
    # the last layer that still holds the reason.
    return StreamingResponse(
        _common.guarded_stream(stream_fn(input_messages)),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )

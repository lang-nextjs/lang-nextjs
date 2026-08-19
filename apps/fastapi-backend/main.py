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
    deepagents.get_graph()
    langgraph.get_graph()
    langchain.get_executor()
    topologies = {
        ai: list(mod.TOPOLOGIES) for ai, mod in _MODULES.items()
    }
    print(f"FastAPI ready: ai_backends={list(_MODULES)} topologies={topologies}")
    yield


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:3002",
        "http://frontend:3001",
        "http://frontend:3002",
    ],
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


# DeepAgents adds these via create_deep_agent middleware (not in the tools list
# we pass) — surface them so the UI shows the agent's real built-in capabilities.
_DEEPAGENTS_BUILTINS = [
    {"name": "write_todos", "description": "Plan and track tasks", "source": "builtin"},
    {"name": "ls", "description": "List files in the workspace", "source": "builtin"},
    {"name": "read_file", "description": "Read a file", "source": "builtin"},
    {"name": "write_file", "description": "Write a file", "source": "builtin"},
    {"name": "edit_file", "description": "Edit a file", "source": "builtin"},
    {"name": "execute", "description": "Run a shell command (sandboxed)", "source": "builtin"},
    {"name": "task", "description": "Delegate to a sub-agent", "source": "builtin"},
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
    if ai_backend == "deepagents":
        tools.extend(_DEEPAGENTS_BUILTINS)
        tools.extend(
            describe(_common.RESEARCH_TOOLS if topology == "deep-research" else _common.TOOLS)
        )
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
    return StreamingResponse(
        stream_fn(input_messages),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )

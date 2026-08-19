"""Django views — dispatches to one of three AI backends × N topologies per route.

Mirror of apps/fastapi-backend/main.py: each route at /api/chat/stream/{ai_backend}/
picks a topology from body.topology (default "react") and dispatches to the
matching async generator in `ai_backends.{deepagents,langgraph,langchain}.TOPOLOGIES`.

Each AI-backend module exposes:
  TOPOLOGIES = {"react": stream_chat_react, "plan-execute": stream_chat_plan_execute, ...}
"""

import json

from django.http import JsonResponse, StreamingHttpResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from .ai_backends import deepagents, langchain, langgraph


_MODULES = {
    "deepagents": deepagents,
    "langgraph": langgraph,
    "langchain": langchain,
}

DEFAULT_TOPOLOGY = "react"


# CSRF requires ambient authority to forge, and none exists here: MIDDLEWARE
# has neither CsrfViewMiddleware nor SessionMiddleware, and these endpoints
# are unauthenticated. The decorator is inert, documenting intent for a
# stateless JSON API. Revisit the moment cookie/session auth appears.
# nosemgrep: python.django.security.audit.csrf-exempt.no-csrf-exempt
@csrf_exempt
@require_http_methods(["POST"])
async def chat_stream_legacy(request):
    """Legacy single-backend endpoint — defaults to deepagents + react.

    Preserved for backward compatibility with single-backend deployments and
    the existing E2E test suite. New code should use
    /api/chat/stream/{ai_backend}/ with body.topology to select a topology.
    """
    return await chat_stream(request, "deepagents")


# CSRF requires ambient authority to forge, and none exists here: MIDDLEWARE
# has neither CsrfViewMiddleware nor SessionMiddleware, and these endpoints
# are unauthenticated. The decorator is inert, documenting intent for a
# stateless JSON API. Revisit the moment cookie/session auth appears.
# nosemgrep: python.django.security.audit.csrf-exempt.no-csrf-exempt
@csrf_exempt
@require_http_methods(["POST"])
async def chat_stream(request, ai_backend: str):
    module = _MODULES.get(ai_backend)
    if module is None:
        return JsonResponse(
            {
                "error": f"unknown ai_backend {ai_backend!r}; "
                f"expected one of {list(_MODULES)}"
            },
            status=404,
        )
    body = json.loads(request.body)
    topology = body.get("topology") or DEFAULT_TOPOLOGY
    stream_fn = module.TOPOLOGIES.get(topology)
    if stream_fn is None:
        return JsonResponse(
            {
                "error": f"unknown topology {topology!r} for ai_backend {ai_backend!r}; "
                f"expected one of {list(module.TOPOLOGIES)}"
            },
            status=404,
        )
    messages = body.get("messages", [])
    user_text = messages[-1].get("content", "") if messages else ""
    input_messages = [{"role": "user", "content": user_text}]
    response = StreamingHttpResponse(
        stream_fn(input_messages),
        content_type="text/event-stream",
    )
    response["Cache-Control"] = "no-cache"
    response["X-Accel-Buffering"] = "no"
    return response


async def health(request):
    return JsonResponse(
        {
            "status": "ok",
            "ai_backends": list(_MODULES),
            "topologies": {
                ai: list(mod.TOPOLOGIES) for ai, mod in _MODULES.items()
            },
        }
    )

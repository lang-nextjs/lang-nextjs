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

from .ai_backends import _common, deepagents, langchain, langgraph


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
            return JsonResponse({"error": str(exc)}, status=400)

        session_id = body.get("sessionId")
        if not isinstance(session_id, str) or not session_id:
            return JsonResponse(
                {
                    "error": (
                        f"no sessionId was named, and topology {topology!r} requires "
                        f"approval. A gated call is paused until someone answers it, "
                        f"and the answer arrives on a later request that has to find "
                        f"the same conversation — without a sessionId there is nothing "
                        f"to resume."
                    )
                },
                status=400,
            )
        _common.set_thread_id(session_id)

        # AND THE DECISION, IF THIS REQUEST CARRIES ONE. Absent is an ordinary turn
        # rather than a refusal -- every normal message arrives without decisions.
        # Present-and-malformed still refuses: a decision this backend cannot read is
        # one it must not guess at, and guessing means choosing between running the
        # tool and not.
        try:
            _common.set_approval_decisions(_common.parse_approval_decisions(body))
        except _common.ApprovalPolicyError as exc:
            return JsonResponse({"error": str(exc)}, status=400)

    # WHAT THIS RUN IS, recorded once, here — the only place that knows.
    #
    # THIS PLANE HAD NO AXES AT ALL. The fastapi dispatch has recorded runtime /
    # framework / topology since #118, so every django trace arrived untagged
    # while its fastapi twin was filterable — and "compare the same framework
    # across two runtimes", which is the comparison this repo exists to make,
    # silently covered only half the fleet.
    #
    # `session` is the conversation id (#171). It used to be a hardcoded
    # constant the route stripped anyway, so the only available values grouped
    # either everything or nothing. set_run_axes drops falsey values, so an
    # older client that sends none produces a trace with no session rather than
    # one grouped under "None".
    _common.set_run_axes(
        runtime="django",
        framework=ai_backend,
        topology=topology,
        session=body.get("sessionId"),
    )
    # WRAPPED, NOT RAW. `StreamingHttpResponse` flushes 200 before it iterates,
    # so an exception from `stream_fn` closes the socket with no terminal frame
    # and the proxy — correctly, from where it sits — calls that a mid-stream
    # disconnect. #247 fixed this on the fastapi plane; this one is a separate
    # implementation and kept the defect until the live-transport job first ran
    # for real and reported `upstream_disconnect` for a fault this process was
    # the only layer still able to name.
    response = StreamingHttpResponse(
        _common.guarded_stream(stream_fn(input_messages)),
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

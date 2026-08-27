"""Shared LLM, tools, and system prompt for all three AI backends.

Tools are stdlib-only HTTP calls to the host's Next.js example app counter API,
so they work identically in any agent framework that consumes LangChain `@tool`.
"""

import json
import contextvars
import os
import urllib.request

from langchain_core.tools import tool


COUNTER_URL = os.environ.get(
    "COUNTER_URL", "http://host.docker.internal:3000/api/counter"
)


@tool
def increment() -> str:
    """Increment the counter by 1 and return the new value."""
    req = urllib.request.Request(COUNTER_URL, method="POST")
    # COUNTER_URL is a module-level constant read from the environment
    # (operator controlled), never request data — there is no untrusted
    # input that could redirect this fetch. The rule fires on any
    # non-literal URL and cannot see that. If this ever takes a
    # caller-supplied URL, drop the suppression: SSRF becomes real.
    # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
    with urllib.request.urlopen(req, timeout=5) as resp:
        data = json.loads(resp.read())
    return f"Counter incremented to {data['counter']}"


@tool
def get_counter() -> str:
    """Read the current counter value."""
    # COUNTER_URL is a module-level constant read from the environment
    # (operator controlled), never request data — there is no untrusted
    # input that could redirect this fetch. The rule fires on any
    # non-literal URL and cannot see that. If this ever takes a
    # caller-supplied URL, drop the suppression: SSRF becomes real.
    # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
    with urllib.request.urlopen(COUNTER_URL, timeout=5) as resp:
        data = json.loads(resp.read())
    return f"Counter is {data['counter']}"


@tool
def web_search(query: str, max_results: int = 5) -> str:
    """Search the web (DuckDuckGo, no API key) and return top results as JSON
    (title, snippet, url). Use this to research a topic before answering."""
    try:
        from ddgs import DDGS
    except ImportError:  # package was duckduckgo_search before the rename
        from duckduckgo_search import DDGS  # type: ignore
    results = []
    with DDGS() as ddgs:
        for r in ddgs.text(query, max_results=max_results):
            results.append(
                {
                    "title": r.get("title"),
                    "snippet": r.get("body"),
                    "url": r.get("href"),
                }
            )
    return json.dumps(results)


TOOLS = [increment, get_counter]

# DeepResearch topology adds web search ON TOP OF the shared tools.
#
# `[*TOOLS, web_search]`, not `[web_search]`. It was the latter, which REPLACED
# the shared tools rather than extending them — so selecting DeepResearch
# silently dropped `increment` and `get_counter`, and the comment above claimed
# the opposite of what the line below did. Measured before the fix:
#   react          11 tools (incl. increment, get_counter)
#   deep-research  10 tools (gained web_search, lost both counters)
# A comment asserting a behaviour the code does not have is the defect class
# this repo keeps finding; here the comment was right and the code was wrong.
RESEARCH_TOOLS = [*TOOLS, web_search]

RESEARCH_PROMPT = """\
You are a research agent. Given a question, use the web_search tool to gather
evidence from multiple sources before answering. Plan your research with the
todo tool, save useful findings to files, and cite the URLs you used. Be
thorough but concise in the final answer.
"""


SYSTEM_PROMPT = """\
You are a concise assistant in the DeepAgents Next.js example app.
When a user request maps to a tool you have available, invoke it through the tool-calling API. Never emit tool calls as text, XML tags (<TOOLCALL>, <tool_call>, etc.), or JSON in your reply — only structured tool calls are dispatched; text-mode markup renders to the user verbatim and never executes.
When the user asks for the same action repeated N times, issue N separate tool calls — one per action — rather than one combined call.
When no available tool matches the request, reply in plain natural language and briefly state what you can do instead.
Keep responses short.
"""


def make_llm():
    """Build the LLM — NVIDIA NIM, then OpenRouter, then Anthropic.

    Returns a LangChain `BaseChatModel`. Both `create_react_agent` (LangGraph)
    and `create_deep_agent` (deepagents) accept a pre-built model instance.

    NVIDIA NIM IS FIRST BECAUSE IT IS THE ONE ANYONE CAN GET. build.nvidia.com
    issues a free key with no card, which makes this repo runnable by a forker
    who has neither an OpenRouter balance nor an Anthropic account. The order is
    a fallback CHAIN, not a preference: whichever key is present wins, and a
    fork with all three set gets NIM.

    THE KEY IS READ FROM THE ENVIRONMENT AND NOWHERE ELSE. There is deliberately
    no per-request override: these graphs are lazily-built singletons, so a key
    arriving in a request body would either be ignored (a dead control) or force
    an agent rebuild on every message. A UI field for it would be one or the
    other, so the settings page reports which provider is configured and leaves
    setting it to the environment.
    """
    nvidia_key = os.environ.get("NVIDIA_API_KEY")
    if nvidia_key:
        from langchain_openai import ChatOpenAI

        # NIM speaks the OpenAI wire format, so ChatOpenAI drives it directly.
        model = os.environ.get("NVIDIA_MODEL", "nvidia/nemotron-3-super-120b-a12b")
        return ChatOpenAI(
            base_url="https://integrate.api.nvidia.com/v1",
            api_key=nvidia_key,
            model=model,
        )

    openrouter_key = os.environ.get("OPENROUTER_API_KEY")
    if openrouter_key:
        from langchain_openai import ChatOpenAI

        model = os.environ.get("OPENROUTER_MODEL", "openai/gpt-4o-mini")
        return ChatOpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=openrouter_key,
            model=model,
        )
    from langchain_anthropic import ChatAnthropic

    return ChatAnthropic(model="claude-3-5-haiku-20241022")


def llm_status() -> dict:
    """Which provider make_llm() WOULD pick, without building anything.

    Presence only — never the key. This exists because the readiness indicator
    was asking the wrong process: the Next.js app reported on its OWN
    environment, but the model is constructed here, so a key present in the
    backend read as "no key configured" in the UI and a key present only in
    Next.js would have read as configured while every send failed.

    MIRRORS make_llm()'s FALLBACK ORDER and must keep mirroring it. If that
    chain changes and this does not, the UI gets a confident wrong answer,
    which is worse than the no answer it had before.
    """
    if os.environ.get("NVIDIA_API_KEY"):
        return {"configured": True, "provider": "nvidia"}
    if os.environ.get("OPENROUTER_API_KEY"):
        return {"configured": True, "provider": "openrouter"}
    if os.environ.get("ANTHROPIC_API_KEY"):
        return {"configured": True, "provider": "anthropic"}
    return {"configured": False, "provider": None}


def _env_flag(name: str) -> bool:
    """True when an env var is set to a truthy spelling."""
    return (os.environ.get(name) or "").lower() in ("1", "true", "yes")


# --- Langfuse -----------------------------------------------------------------
#
# Langfuse does not read the environment on its own the way LangChain does for
# LangSmith. It needs a CallbackHandler passed into EVERY graph invocation, so
# the helpers below exist to make that one decision in one place and let the six
# backend modules share it.

_LANGFUSE_CACHE: dict = {}


def langfuse_configured() -> bool:
    """Both keys present. Presence only — the values are never read out."""
    return bool(
        os.environ.get("LANGFUSE_PUBLIC_KEY") and os.environ.get("LANGFUSE_SECRET_KEY")
    )


def langfuse_callbacks() -> list:
    """Handlers to attach to a graph run, or [] when Langfuse is not usable.

    RETURNS [] RATHER THAN A NO-OP HANDLER, deliberately. A handler that
    silently discards spans would make `tracing` unfalsifiable: every call site
    would look wired, nothing would arrive, and no status could tell the
    difference. An empty list is the honest representation of "not tracing" and
    it is what `observability_status()` reads to decide `configured`.

    [] is returned when the keys are absent OR the SDK is not installed. The
    import failure is swallowed on purpose: a backend whose requirements have
    drifted should degrade to untraced, not refuse to answer chat requests.
    """
    if not langfuse_configured():
        return []
    if _LANGFUSE_CACHE.get("unavailable"):
        return []

    handler = None
    try:
        # v3+ SDK. It reads LANGFUSE_PUBLIC_KEY / SECRET_KEY / HOST from the
        # environment itself, which is why nothing is passed here.
        #
        # THE v2 IMPORT PATH (`langfuse.callback`) IS DELIBERATELY NOT TRIED.
        # It cannot work in this repo and falling back to it would only convert
        # a clear failure into a confusing one: v2's handler imports
        # `langchain.callbacks`, which LangChain 1.x removed, so on
        # langchain 1.3.17 it raises ModuleNotFoundError on import. Measured,
        # not assumed — see scripts/langfuse-local/README.md.
        from langfuse.langchain import CallbackHandler

        handler = CallbackHandler()
    except Exception:
        # Import error, bad credentials, anything: degrade to untraced rather
        # than refuse to serve chat. observability_status() reports the failure.
        handler = None

    if handler is None:
        _LANGFUSE_CACHE["unavailable"] = True
        return []
    return [handler]


# ── which run this is ──────────────────────────────────────────────────────
#
# WHY A CONTEXTVAR AND NOT A PARAMETER. The axes are known in main.py's
# dispatch and needed in langfuse_config(), which is called from a dozen sites
# across three backend modules — every one of them inside a `config=` kwarg on
# a graph invocation. Threading two strings through all of them would change
# every stream function's signature to carry something none of them use.
#
# A ContextVar is per-task and async-safe: concurrent requests each see their
# own, which a module-level global would not survive.
_RUN_AXES: contextvars.ContextVar[dict] = contextvars.ContextVar(
    "run_axes", default={}
)


def set_run_axes(**axes) -> None:
    """Record what this request is, for whatever tracing is attached to it.

    Called once per request from the dispatch that actually knows. Values that
    are None are dropped rather than recorded as "None" — an absent axis and an
    axis whose value is the string "None" are different facts, and only one of
    them is true.
    """
    _RUN_AXES.set({k: v for k, v in axes.items() if v})


def langfuse_trace_metadata() -> dict:
    """Tags and session for the current request, in the SDK's own vocabulary.

    THE AXES WERE ALREADY IDENTIFIABLE AND NOT QUERYABLE. A trace arrived named
    `fastapi-deepagents-react`, so the runtime, framework and topology were all
    in there — baked into one opaque string, with `tags: []` beside it. Finding
    every langgraph run meant substring-matching a name, and comparing two
    frameworks' cost meant doing that twice by hand.
    
    These key names are not a guess: `langfuse_session_id`, `langfuse_tags` and
    `langfuse_user_id` are read by langfuse 3.15's own
    langchain/CallbackHandler.py, which is what this repo installs.

    Tags are `axis:value`, so Langfuse's tag filter groups them: `framework:
    langgraph` selects a framework across every topology, and
    `topology:plan-execute` cuts the other way across every framework. That
    second cut is the one this repo exists to make, and a separate project per
    framework would have made it impossible without switching context.
    """
    axes = dict(_RUN_AXES.get())
    if not axes:
        return {}
    # `session` is honoured if a caller ever supplies a real one, and nothing
    # does today: see the note in main.py's dispatch and #171. It is pulled out
    # rather than tagged, because a session is an identity, not an axis.
    session = axes.pop("session", None)
    md: dict = {"langfuse_tags": [f"{k}:{v}" for k, v in sorted(axes.items())]}
    if session:
        md["langfuse_session_id"] = session
    return md


def langfuse_config() -> dict:
    """`config=` kwarg for a graph invocation — `{}` when Langfuse is off.

    Returning `{}` rather than `{"callbacks": []}` matters: an empty callbacks
    list passed into LangChain REPLACES inherited callbacks on nested runs, so
    the empty-but-present form would actively suppress tracing a parent had set
    up. `{}` leaves the caller's config untouched.
    """
    handlers = langfuse_callbacks()
    if not handlers:
        return {}
    cfg: dict = {"callbacks": handlers}
    md = langfuse_trace_metadata()
    if md:
        cfg["metadata"] = md
    return cfg


def langfuse_probe(timeout_seconds: float = 2.0):
    """Ask Langfuse whether it accepts our credentials. Tri-state, cached.

    True  -> the server authenticated us
    False -> we asked and it refused, or the SDK could not be built
    None  -> we could not ask within `timeout_seconds`, so nothing is known

    NONE IS NOT FALSE and the distinction is the point. `/health` is what a
    container healthcheck hits on a 5s budget, so an unbounded network call here
    would take the backend down whenever Langfuse was merely slow. The probe is
    therefore deadline-bounded, and a deadline miss reports "never probed"
    rather than inventing a negative.
    """
    if "probe" in _LANGFUSE_CACHE:
        return _LANGFUSE_CACHE["probe"]

    handlers = langfuse_callbacks()
    if not handlers:
        return False if langfuse_configured() else None

    import concurrent.futures

    def _check():
        # v3 exposes the client through the module-level singleton rather than
        # hanging it off the handler, which is why this does not introspect
        # `handlers[0]`.
        from langfuse import get_client

        client = get_client()
        if client is None or not hasattr(client, "auth_check"):
            return None
        return bool(client.auth_check())

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            result = pool.submit(_check).result(timeout=timeout_seconds)
    except concurrent.futures.TimeoutError:
        return None  # deliberately NOT cached — a slow server may answer later
    except Exception:
        result = False

    _LANGFUSE_CACHE["probe"] = result
    return result


def _langfuse_detail(configured: bool, tracing) -> str:
    """One sentence per tri-state, so no state renders as an unexplained blank."""
    if not configured:
        return "set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY"
    if tracing is True:
        return "tracing — Langfuse accepted our credentials"
    if tracing is False:
        return (
            "keys set, but Langfuse refused them or the langfuse SDK is missing "
            "— no spans are being accepted"
        )
    return "keys set and a handler is attached, but Langfuse has not answered yet"


def observability_status() -> dict:
    """Which tracing integrations are configured, and which actually TRACE.

    THE TWO ARE NOT THE SAME, and conflating them is the failure this reports
    around. LangSmith needs no code here: LangChain reads LANGCHAIN_TRACING_V2
    and LANGCHAIN_API_KEY from the environment itself, and these backends
    already set `run_name=`/`name=` so traces arrive labelled. Setting those
    vars genuinely turns tracing on.

    Langfuse does NOT work that way. It needs a CallbackHandler passed into the
    graph invocation. As of #118 this codebase passes one at every invocation
    site in both runtimes, so `supported` is now True — and it means "this
    codebase attaches a handler", a fact about the CODE. It does not mean the
    server is reachable.

    `tracing` remains the only field that claims anything about the world, and
    for Langfuse it is now genuinely computable for the first time: True only if
    Langfuse authenticated us, False if it refused or no handler could be built,
    None if we never got an answer inside the deadline. None is not False, and a
    key in the environment on its own never sets it True.
    """
    # BOTH SPELLINGS. The langsmith SDK accepts LANGSMITH_* as well as the older
    # LANGCHAIN_*, and reading only the old names produced a FALSE NEGATIVE ON
    # EGRESS: measured against a stand-in LangSmith endpoint, a backend with only
    # LANGSMITH_TRACING + LANGSMITH_API_KEY set POSTed 4 run batches while this
    # function reported configured=false, project=null, and told the operator to
    # set the LANGCHAIN_* vars. An operator reads that as "no span data leaves
    # this process" — and user prompts were leaving it. Over-claiming tracing is
    # embarrassing; under-claiming egress is the one that gets acted on.
    #
    # `or` rather than a precedence order is deliberate. Project precedence IS
    # measured (see "project" below); the precedence of the two tracing FLAGS
    # against each other is not, so this encodes no guess about it. For a field
    # read as an egress claim, "either says on -> report on" is the bias that
    # cannot produce the dangerous answer.
    langsmith_on = _env_flag("LANGSMITH_TRACING") or _env_flag(
        "LANGCHAIN_TRACING_V2"
    )
    langsmith_key = bool(
        os.environ.get("LANGSMITH_API_KEY") or os.environ.get("LANGCHAIN_API_KEY")
    )
    langfuse_key = bool(
        os.environ.get("LANGFUSE_PUBLIC_KEY") and os.environ.get("LANGFUSE_SECRET_KEY")
    )
    langfuse_tracing = langfuse_probe()

    return {
        "langsmith": {
            # Both halves are needed: tracing enabled AND a key to send with.
            "configured": langsmith_on and langsmith_key,
            # THREE-STATE, AND null IS THE HONEST ANSWER TODAY.
            #   True  -> a span was accepted
            #   False -> a send was attempted and failed
            #   None  -> never probed
            # This was `langsmith_on and langsmith_key` — the SAME expression as
            # `configured` — so it reported "traces are arriving" on the strength
            # of two env vars being set, having watched nothing. That is the
            # defect this file was written to avoid, with the sign flipped:
            # langfuse under-claimed honestly while langsmith over-claimed.
            # Nothing here sends a probe span yet, so the answer is None.
            # Caught by DEV8 while reviewing the payload shape.
            "tracing": None,
            "supported": True,
            # LANGSMITH_PROJECT wins over LANGCHAIN_PROJECT — MEASURED, not
            # assumed: with both set to different values, the session_name that
            # actually went over the wire was the LANGSMITH_ one.
            "project": (
                os.environ.get("LANGSMITH_PROJECT")
                or os.environ.get("LANGCHAIN_PROJECT")
                or None
            ),
            # Was "tracing" — which asserted in prose exactly what `tracing:
            # None` above declines to assert. A detail string that contradicts
            # its own field is the same over-claim one layer down.
            "detail": (
                "configured — not verified, no span has been observed"
                if (langsmith_on and langsmith_key)
                else "set LANGSMITH_TRACING=true and LANGSMITH_API_KEY "
                "(LANGCHAIN_TRACING_V2 / LANGCHAIN_API_KEY also accepted)"
            ),
        },
        "langfuse": {
            "configured": langfuse_key,
            # The ONLY field here that asks the world anything. Deadline-bounded
            # inside langfuse_probe() so a slow server cannot hang the container
            # healthcheck that hits this endpoint on a 5s budget.
            "tracing": langfuse_tracing,
            # "this codebase attaches a handler to every run" — a fact about the
            # code, not about reachability. Earned by #118; see langfuse_config().
            "supported": True,
            "host": os.environ.get("LANGFUSE_HOST") or "https://cloud.langfuse.com",
            "detail": _langfuse_detail(langfuse_key, langfuse_tracing),
        },
    }

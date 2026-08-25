"""Shared LLM, tools, and system prompt for all three AI backends.

Tools are stdlib-only HTTP calls to the host's Next.js example app counter API,
so they work identically in any agent framework that consumes LangChain `@tool`.
"""

import json
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

# DeepResearch topology adds web search on top of the shared tools.
RESEARCH_TOOLS = [web_search]

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
        model = os.environ.get("NVIDIA_MODEL", "meta/llama-3.3-70b-instruct")
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


def observability_status() -> dict:
    """Which tracing integrations are configured, and which actually TRACE.

    THE TWO ARE NOT THE SAME, and conflating them is the failure this reports
    around. LangSmith needs no code here: LangChain reads LANGCHAIN_TRACING_V2
    and LANGCHAIN_API_KEY from the environment itself, and these backends
    already set `run_name=`/`name=` so traces arrive labelled. Setting those
    vars genuinely turns tracing on.

    Langfuse does NOT work that way. It needs a CallbackHandler passed into the
    graph invocation, and nothing here passes one. So a Langfuse key in the
    environment means "the operator expects tracing" while no span is ever
    emitted — and reporting that as `configured` would be a status claiming a
    verdict it never computed. It is reported as detected-but-not-wired, which
    is the true statement.
    """
    langsmith_on = os.environ.get("LANGCHAIN_TRACING_V2", "").lower() in (
        "1",
        "true",
        "yes",
    )
    langsmith_key = bool(
        os.environ.get("LANGCHAIN_API_KEY") or os.environ.get("LANGSMITH_API_KEY")
    )
    langfuse_key = bool(
        os.environ.get("LANGFUSE_PUBLIC_KEY") and os.environ.get("LANGFUSE_SECRET_KEY")
    )

    return {
        "langsmith": {
            # Both halves are needed: tracing enabled AND a key to send with.
            "configured": langsmith_on and langsmith_key,
            "tracing": langsmith_on and langsmith_key,
            "supported": True,
            "project": os.environ.get("LANGCHAIN_PROJECT") or None,
            "detail": (
                "tracing"
                if (langsmith_on and langsmith_key)
                else "set LANGCHAIN_TRACING_V2=true and LANGCHAIN_API_KEY"
            ),
        },
        "langfuse": {
            "configured": langfuse_key,
            # Deliberately false even when keys are present — see docstring.
            "tracing": False,
            "supported": False,
            "detail": (
                "keys detected, but no callback handler is wired — no spans are sent"
                if langfuse_key
                else "not integrated"
            ),
        },
    }

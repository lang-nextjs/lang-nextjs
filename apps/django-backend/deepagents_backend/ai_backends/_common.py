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


TOOLS = [increment, get_counter]


SYSTEM_PROMPT = """\
You are a concise assistant in the DeepAgents Next.js example app.
When a user request maps to a tool you have available, invoke it through the tool-calling API. Never emit tool calls as text, XML tags (<TOOLCALL>, <tool_call>, etc.), or JSON in your reply — only structured tool calls are dispatched; text-mode markup renders to the user verbatim and never executes.
When the user asks for the same action repeated N times, issue N separate tool calls — one per action — rather than one combined call.
When no available tool matches the request, reply in plain natural language and briefly state what you can do instead.
Keep responses short.
"""


def make_llm():
    """Build the LLM — prefers OpenRouter, falls back to Anthropic.

    Returns a LangChain `BaseChatModel`. Both `create_react_agent` (LangGraph)
    and `create_deep_agent` (deepagents) accept a pre-built model instance.
    """
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

"""Three AI-backend implementations dispatched by `/api/chat/stream/{ai_backend}`.

Each module owns a complete (agent framework, wire format) pair representing a
real-world deployment shape:

  * deepagents  — uses the `deepagents` library; emits AI SDK v6 wire format
                  (paired with `deepagentsAdapter` in the Next.js proxy).
  * langgraph   — uses LangGraph `create_react_agent`; emits raw `astream_events`
                  v2 JSON dumps (paired with `langGraphAdapter`).
  * langchain   — uses LangChain `AgentExecutor` + `create_openai_tools_agent`;
                  emits LangChain native SSE (`event: token` / `event: tool_call` /
                  `event: message`) (paired with `langchainAdapter`).

All three share tool definitions, system prompt, and LLM construction in
`_common.py`, so the only thing that varies is the agent framework + wire format.
"""

from . import _common, deepagents, langchain, langgraph

__all__ = ["_common", "deepagents", "langchain", "langgraph"]

# Exposing the full open-swe agent narrative

This documents the work to surface **all** of open-swe's agent features (plans,
files, sub-agents, human-in-the-loop) in the Next.js app — not just raw text +
tool JSON. It records the ground-truth open-swe vocabulary, the adapter mapping,
and the (important) HITL design, so the build is reviewable and resumable.

## Background — the gap

The `@deepagents-nextjs/*` SDK is feature-complete: nine `data-*` parts
(plan/task/file/approval/sub-agent/human-response/error/todo/agents-md) each have
a React card + the chat/approval hooks. But `apps/open-swe` consumed almost none
of it — it depended only on `@deepagents-nextjs/server` (`createReadinessProbe`),
hand-rolled its own EventSource streaming, and rendered only a minimal `ToolCard`.
And **no adapter emitted the rich `data-*` parts** — `openSweAdapter` only mapped
`on_tool_start/end` → tool frames. So the cards had no data to render.

## Ground truth — open-swe's streaming vocabulary

open-swe is a real DeepAgents agent (`create_deep_agent`), graph id **`agent`**
(not `open-swe`). Derived from source (langchain-ai/open-swe):

| Concept              | Mechanism                                                                                                                                                                                                                             | Surfaces as                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| File read/write/edit | DeepAgents tools `read_file`, `write_file(file_path,content)`, `edit_file(file_path,old_string,new_string)`                                                                                                                           | tool calls; write/edit results carry `artifact.diff = {filePath,newContent,isNewFile}` |
| Shell                | `execute(command,timeout?)`                                                                                                                                                                                                           | tool call                                                                              |
| Search               | `ls`, `glob`, `grep`                                                                                                                                                                                                                  | tool calls                                                                             |
| Sub-agents           | `task(...)` tool spawns a fresh sub-agent                                                                                                                                                                                             | tool call `name:"task"`; UI correlates by toolCallId                                   |
| Plan                 | `enter_plan_mode` (flips `plan_mode=True`) + `save_plan(plan_markdown)`                                                                                                                                                               | tool calls + `plan_mode` state key                                                     |
| **HITL**             | **NOT langgraph `interrupt()`.** `enter_plan_mode` ends the run; a human approves/rejects via `POST /dashboard/api/plan/{thread}/approve\|reject`, which **dispatches a NEW run** with the plan + feedback and `plan_mode=False/True` | external REST, not stream resume                                                       |
| Streaming            | LangGraph v2 (astream_events / stream modes); **no custom events**                                                                                                                                                                    | `messages`, tool calls, `values`/`updates`                                             |

> open-swe does **not** use the DeepAgents `write_todos` tool, so `data-todo`
> won't be emitted for it; planning is freeform markdown via `save_plan`.

## Adapter mapping (DONE — `packages/server/src/adapters/openSweEnrich.ts`)

A second transform runs after the tool-normalizer and fans out a `data-*` part
next to each recognized tool frame (the tool frame is preserved so `ToolCard`
still works for everything):

| open-swe tool     | emits                                                               |
| ----------------- | ------------------------------------------------------------------- |
| `save_plan`       | `data-plan` (markdown from `plan_markdown`)                         |
| `enter_plan_mode` | `data-approval` (status `waiting`, `id`=toolCallId — the plan gate) |
| `write_file`      | `data-file` on start (content from args)                            |
| `edit_file`       | `data-file` on end (new content from `artifact.diff.newContent`)    |
| `read_file`       | `data-file` on end (content from output)                            |
| `task`            | `data-sub-agent` (`starting` on input → `done`+result on output)    |

Covered by `openSweEnrich.test.ts` (14 cases). Wired via
`openSweAdapter.transforms = [normalize, enrich]`.

## App rendering (DONE)

- The run stream route now pipes upstream through `openSweAdapter` server-side
  via a new reusable `transformSseStream` helper (`packages/server`), so the
  browser receives ready-to-render `text-delta` / `tool-*` / `data-*` frames.
- `apps/open-swe` now depends on `@deepagents-nextjs/react`. `lib/agent-parts.ts`
  (`collectAgentParts`, upsert-by-id + parseDataPart) feeds `components/
AgentNarrative.tsx`, which renders `PlanCard`, `SubAgentCard`, `FileCard`, and
  the HITL `ApprovalCard`, hiding the raw `ToolCard` for any tool that became a
  rich card and keeping it for the rest (execute/ls/grep/…).
- Tests: `agent-parts.test.ts`, `AgentNarrative.test.tsx`,
  `stream-transform.test.ts`, `openSweEnrich.test.ts`.

## HITL (DONE — pending live validation)

`data-approval` (the plan-mode gate) → `ApprovalCard`. Approve/reject POST to a
new route `POST /api/open-swe/runs/[runId]/plan`, which calls `resumePlan()` —
dispatching a **follow-up run** on the thread with the decision message and
`plan_mode` flag (open-swe's new-run model, NOT a stream resume). The exact
follow-up message format + thread-run endpoint are marked OPEN QUESTION in
`langgraph-client.ts` and need confirming against a live open-swe.

## Live validation (DONE for file ops — no GitHub App / LangSmith needed)

A real open-swe was brought up locally with a **minimal** footprint — no GitHub
App, no LangSmith, no Anthropic key:

- `uv sync` + `uv run langgraph dev` (serves the `agent` graph on :2024).
- `.env`: `SANDBOX_TYPE=local` (runs tools on a local dir, no hosted sandbox),
  `LOCAL_SANDBOX_ROOT_DIR=/tmp/open-swe-workdir`, `DEFAULT_MODEL_ID=openai:gpt-5.5`
  with an `OPENAI_API_KEY` (open-swe's default model is already OpenAI).
- The `agent` graph gates on `resolve_github_token` (`auth.py`) before running;
  for headless capture a one-line test-only bypass (`OPEN_SWE_LOCAL_GITHUB_TOKEN`,
  fed a plain `gh` PAT) skips the App/OAuth flow. Local clone only — not committed.

Real coding tasks ran end-to-end (agent added `subtract()` to calc.py, created
mathutils.py) and the captured astream_events were replayed through the built
`openSweAdapter`. **Confirmed exact-match** against real output:

| tool            | live `on_tool_start.input`            | live `on_tool_end.output`                             | adapter result                   |
| --------------- | ------------------------------------- | ----------------------------------------------------- | -------------------------------- |
| `read_file`     | `{file_path, offset, limit}`          | `{content, artifact: null}`                           | `data-file` (content) ✓          |
| `edit_file`     | `{file_path, old_string, new_string}` | `{artifact:{diff:{filePath, newContent, isNewFile}}}` | `data-file` (diff.newContent) ✓  |
| `write_file`    | `{file_path, content}`                | —                                                     | `data-file` on start (content) ✓ |
| `ls`, `execute` | —                                     | —                                                     | tool frame only (ToolCard) ✓     |

**Still source-validated only** (not triggered headlessly — `plan_mode` is gated
by open-swe's dashboard flow): `enter_plan_mode`/`save_plan` (→ `data-plan` /
`data-approval`) and `task` (→ `data-sub-agent`). Covered by unit fixtures; a
planning-triggering run via the dashboard would confirm them live.

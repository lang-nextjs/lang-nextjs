# Cleanup Report — v1.2-01 Backend Adapter API & Retry Policy

## Findings

| Issue | File | Line(s) | Type | Severity | Notes |
|-------|------|---------|------|----------|-------|
| Over-defensive null check on guaranteed-non-null field | `langchain.ts` | 54–55 | Over-defensive | Low | `chunk.content` already type-narrowed in `on_chat_model_stream` case; nullish coalescing to `''` is safe but unnecessary branching. The optional chaining is defensive against malformed LangGraph JSON; safe to keep. |
| Redundant object-construction in error transform | `langchain.ts` | 89 | Redundant | Low | Line 89: `const toolInput = (parsed.tool_input as Record<string, unknown>) ?? {}` — the nullish coalesce to `{}` happens unconditionally even though the value is always used in the next line. No behavioral issue; style preference. |
| Deprecated export still present | `transforms.ts` | 67 | Dead Code | Medium | `defaultTransforms` is marked `@deprecated` but still exported and still in public API. Plan removal for next major version; currently harmless but clutters exports. |
| Over-defensive null check on field guaranteed by TypeScript | `transforms.ts` | 32–36 | Over-defensive | Low | The `parsed !== null && typeof parsed === "object"` checks are defensive against JSON deserialization producing non-objects. Valid defense against unexpected JSON shapes, so reasonable to keep. |
| Redundant retry delay calculation comment | `handler.ts` | 100 | Comment Clarity | Trivial | Delay formula comment is correct but slightly verbose. Could compress without loss of clarity. |
| Unused/unreachable comment blocks | `langgraph.ts` | 64–68 | Dead Code | Trivial | `on_tool_start` and `on_tool_end` event cases explicitly marked as "not present in fixture" with no implementation. Appropriate for current phase (v1.2-01-01); remove when fixture updates to include these events. |

## Total: 6 findings

**Summary**: The codebase is well-defended with explicit null checks and transformation logic. One deprecated export (`defaultTransforms`) should be tracked for removal in the next major version. No blocking issues; all findings are low-to-trivial severity. The over-defensive patterns are justified given the untrusted JSON from external backends.

**Recommendations**:
1. Remove `defaultTransforms` export in next major version (track in migration guide).
2. Keep null checks in `transforms.ts` and `langchain.ts` — they defend against malformed backend JSON.
3. Update comment blocks in `langgraph.ts` when fixture is extended to include `on_tool_start`/`on_tool_end`.

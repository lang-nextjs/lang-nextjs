# Phase v1.3-02 Cleanup Report

## Summary

The edge runtime adapter code is lean and well-structured. No dead code or unreachable branches were found. A small number of findings are documented below.

---

## Findings

### 1. BUG: `SseFrameAccumulator` exported as type-only (prevents consumer instantiation)

**File:** `packages/edge/src/index.ts` line 3

```ts
export type { SseFrame, SseTransform, SseFrameAccumulator } from './accumulator';
```

`SseFrameAccumulator` is a **class** (a runtime value). Exporting it with `export type` erases it at runtime -- consumers importing from `@deepagents-nextjs/edge` cannot `new SseFrameAccumulator()`.

**Fix:** Split into value and type exports:

```ts
export { SseFrameAccumulator } from './accumulator';
export type { SseFrame, SseTransform } from './accumulator';
```

**Severity:** Medium -- breaks any external consumer who wants to use the accumulator directly.

---

### 2. Unused `env` field on `CloudflareHandlerOptions`

**File:** `packages/edge/src/types.ts` lines 39-42

```ts
export interface CloudflareHandlerOptions extends EdgeHandlerOptions {
  env?: Record<string, unknown>;
}
```

The `env` field is never read inside `createCloudflareHandler`. The consumer extracts `backendUrl` from `env` *before* calling the factory (as shown in the JSDoc example), so this field serves no runtime purpose.

**Recommendation:** Remove `env` from the interface in a future minor release. It adds cognitive overhead without utility. Leaving it is harmless but misleading -- consumers may think the handler reads from it.

**Severity:** Low -- no runtime impact, purely interface noise.

---

### 3. Over-defensive runtime check: `backendUrl` emptiness guard inside handler

**Files:** `deno-handler.ts` line 55, `cloudflare-handler.ts` line 76

```ts
if (!options.backendUrl) {
  console.error('...');
  return new Response('Service Unavailable: BACKEND_URL not configured', { status: 503 });
}
```

`backendUrl` is typed as `string` (non-optional) in `EdgeHandlerOptions`. The guard fires only if a consumer passes an empty string or bypasses TypeScript entirely. This is a minor over-defensive pattern but acceptable for a network boundary (fail-fast at the edge is reasonable). **No action recommended** -- the cost is one boolean check per request.

**Severity:** Informational only.

---

### 4. Duplicate logic between handlers (noted, not actionable)

`deno-handler.ts` and `cloudflare-handler.ts` share ~90% identical logic:
- `HOP_BY_HOP` constant
- `applyTransforms` function
- Header forwarding logic
- Stream reading/transform loop
- Response construction

This is explicitly out of scope per task constraints. Documenting for future reference -- if a third handler is added, extracting shared logic into an internal utility would be warranted.

---

## Applied Fixes

| # | Finding | Action Taken |
|---|---------|--------------|
| 1 | `export type` on class | **Fix applied** (see below) |
| 2 | Unused `env` field | Not fixed (public API change) |
| 3 | Runtime `backendUrl` guard | No fix needed |
| 4 | Duplicate logic | Out of scope |

---

## Fix Applied: index.ts export correction

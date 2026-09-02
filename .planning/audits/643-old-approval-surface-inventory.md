# The old approval surface, inventoried (#643 item 5)

**Measured at `0a994afc881d37fdc682ff4b603f76d24b493424`** (main, 2026-09-01). Item 5 will not be
worked today, so the tree this describes is pinned rather than implied — the last
audit I wrote went stale 47 minutes after I committed it.

**Nothing is deleted here.** #332's sequencing puts this last, and item 4 may change
what "the new surface" is.

## Two derivations, and they disagree — which is the finding

| derivation                                                                                  | key    | result                                                                                |
| ------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| **A** — any textual occurrence over `git ls-files`, excluding `node_modules`/`.next`/`dist` | string | `data-approval-required` **57**, `createApprovalGatingTransform` **38**, union **70** |
| **B** — occurrences surviving comment/docstring/prose stripping                             | code   | **33**, corrected to **32** (see below)                                               |

A reproduces the widest prior attempt exactly (57 / 38). The gap is not error: **38 of
the 70 files mention the surface only in prose or comments** — history notes, checker
headers explaining what is being replaced, and `rungs.json`'s `_rendererNote`. Counting
those measures the discussion, not the surface.

### B's one blind spot, found and corrected

B strips comments per language. **JSON has no comment syntax**, so prose living in JSON
string fields survives stripping and reads as code. Both JSON files were inspected by
parsing rather than grepping:

- `rungs.json` — both hits are inside `shared._rendererNote`. **Prose. Reclassified out.**
- `docs/sse-frame-schema.json` — `oneOf[14].title` and `oneOf[14].properties.type.const`
  are structural. **Surface. Kept.** (Its two `description` hits are prose.)

So B is **32**, and the honest denominator for "what must change" is 32, not 70 and not 57.

### And a derivation that failed silently, recorded because it would have shipped

My first attempt at A used `xargs -a`, which is GNU-only. macOS rejected the flag,
printed a usage message, produced **zero files for both symbols — and exited 0**. A
broken instrument reporting a clean zero is the failure this repository keeps finding;
it was caught only by a positive control on a string I knew was present.

## The categories — what would have to change

### 1. The surface itself (5 files)

| file                                     | what                                                             |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `packages/server/src/approval-gating.ts` | defines `createApprovalGatingTransform`                          |
| `packages/server/src/index.ts:40`        | exports it from the barrel                                       |
| `packages/server/src/handler.ts:27`      | imports and wires it into the handler                            |
| `packages/react/src/schemas.ts:427`      | `"data-approval-required": ApprovalSchema` in the registered map |
| `docs/sse-frame-schema.json` `oneOf[14]` | declares the frame's wire schema                                 |

### 2. Tests of the old surface — delete WITH it, never before (8 files)

`approval-gating.test.ts`, `approval-cannot-veto.test.ts`, `approval-drain-boundary.test.ts`,
`approval-drain-on-close.test.ts`, `approval-owner.test.ts`,
`handler-drain-every-transform.test.ts`, `handler.test.ts` (partial),
`public-api.test.ts` (partial — it asserts the export EXISTS, so it fails the moment the
barrel entry goes).

### 3. Cross-package suites that DRIVE it to test something else — rewire, do not delete (2)

`packages/test-utils/src/error-origin-totality.test.ts` and
`approval-frame-conformance.test.ts` both `import { createApprovalGatingTransform }` and use
it as the vehicle for a different property. Deleting them loses coverage that is not about
approval at all; they need pointing at the new gate.

### 4. Registries and parity tables — must be UPDATED, and are expired-premise risks (4)

`apps/open-swe/app/schema-render-parity.test.tsx` (a table of receivable frames),
`packages/server/src/sse-frame-rung-attribution.test.ts` (asserts
`producers["data-approval-required"]` contains an anchor), `packages/react/src/schemas.test.ts`,
`packages/server/src/sse-frame-schema.test.ts`.

These name the frame as a thing that exists. **The day it stops existing, an assertion of
the form "X is declared" either fails loudly or — worse — is deleted along with X and takes
its sibling coverage with it.** They are the files to touch most carefully.

### 5. Live consumers — BLOCKED ON ITEM 4 (5 files)

`apps/open-swe/app/api/chat/stream/route.ts:287` **calls** `createApprovalGatingTransform`;
`apps/example/app/hitl-demo/page.tsx` and `apps/open-swe/app/page.tsx` type and narrow on the
frame; plus the two route tests. **I am not classifying these further.** Whether they migrate, and to what, is item
4's outcome — `tool-approval-request` versus keeping `data-approval-pause`. Guessing here
would be inventing the answer to somebody else's open decision.

### 6. E2E asserting user-visible behaviour (3)

`e2e/hitl.spec.ts`, `e2e/shell/approval.spec.ts`, `e2e/shell/approval-card-legibility.spec.ts`.
These follow the consumers, so they are blocked on item 4 too.

### 7. Checker fixtures — not surface (2)

`scripts/assert-behavioural-evidence.selftest.mjs` uses the symbol inside a **synthetic**
barrel it writes itself, and `payload-triangulation.selftest.mjs` names the frame in fixture
data. Neither reads the real symbol, so neither breaks when it goes. Listed so nobody
"cleans them up" as part of the deletion.

### 8. Rung-owned (3)

`packages/server/src/adapters/langchain.test.ts` (rung `langchain`),
`packages/server/src/adapters/sdaEnrich.ts` and its test (rung `software-developer-agent`).

**The "eject deletes them anyway" reading holds for a FORK and not for main.** A rung-1
fork never sees them; main still has to change them. Both readings are true of different
trees, which is exactly the kind of thing that produces a factor-of-four disagreement.

## The categories account for all 32, checked by set difference

Summing the categories gave **31 against 32**, and the missing file was found by
differencing the category lists against the measured set rather than by adjusting the
total: `apps/open-swe/app/page.tsx`, a consumer that types and narrows on the frame at
lines 570 and 616. The reverse difference is empty — nothing is classified that the
measurement did not find.

5 + 8 + 2 + 4 + 5 + 3 + 2 + 3 = 32.

## What I did not determine

- Whether categories 5 and 6 are deletions or migrations. That is item 4's, and i6-f0 is
  deciding it.
- Whether any category-4 assertion should SURVIVE as an absence check. That depends on
  whether the frame is replaced or simply removed — also item 4.

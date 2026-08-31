# Specimen — `data-approval-pause`, emitted and declared nowhere (#448)

**This is the state main was actually in, not a constructed example.** It is preserved because
the live tree stops exhibiting the defect the moment #458 lands, and a check with no red to
reproduce is the defect #448 exists to close, manufactured by the order we merge in.

## Provenance

| | |
|---|---|
| observed | 2026-08-31T09:55:14Z |
| `origin/main` | `b1a606dc9003f372e43a4c22b9b77a960958f44e` — *test(server): the close-time gate report no longer races the expiry (#434)* |
| branch observed from | `fix/448-every-payload-declared` @ `da423a0`, whose only delta to main here is a comment |
| emitter | `packages/server/src/adapters/langchain.ts:260` |
| declaration | none — zero entries in `SCHEMA_MAP`, zero in `docs/sse-frame-schema.json`, zero in any JSON in the repo |
| fixed by | #458 (DEV3's #420 mount), which registers the payload and takes the difference to zero |

`SCHEMA_MAP.as-of-2026-08-31.txt` and `emitter.as-of-2026-08-31.txt` are the two facts, copied
verbatim: eleven declared parts on one side, a twelfth on the wire on the other.

## What was observed

Running `scripts/payload-triangulation.mjs` against that tree with the
`ALLOWLIST.undeclared` entry removed — the entry is what lets it pass on a tree that still has
the defect — `observed-output.txt` is verbatim:

```
  emitted, not declared   1 — data-approval-pause
FAIL:
  - EMITTED BUT NEVER DECLARED: data-approval-pause — packages/server/src/adapters/langchain.ts
    sends it and SCHEMA_MAP does not list it, so every other assertion in this file silently
    excludes it. Add it to SCHEMA_MAP with a schema and a mount.
```

Exit **1**. That single observation on the real tree is the reproduction; everything below is
the durable copy of it.

## Why it is not a checked-in tree

#406's specimen is a git ref. A directory specimen cannot work for this checker: it requires
`apps/`, `packages/react`, `packages/server` and `docs/sse-frame-schema.json` all present, or
its own vacuity floors refuse before reaching the assertion — which is essentially the whole
repository. So the durable form is this record plus a selftest case that RECONSTRUCTS the
condition from the live tree, using the real tag and the real emitter rather than an invented
one.

## The two arms, and why neither alone proves anything

| arm | tree | must |
|---|---|---|
| REJECT | live tree with the `data-approval-pause` declaration removed, emitter intact | exit 1, naming the payload |
| ACCEPT | the live tree | exit 0 — after #458 because the sets agree, before it because the allowlist entry says so and is itself asserted to go stale |

The reject arm carries two guards against becoming an expired negative, both of which this
repository has been bitten by:

1. it asserts the emitter **still contains the literal**, so if the emitter is ever moved or
   deleted the case fails loudly instead of quietly testing nothing;
2. it asserts the removal **actually changed the file**, so once #458 declares the payload and
   the removal becomes a real edit, a no-op cannot pass as a mutation.

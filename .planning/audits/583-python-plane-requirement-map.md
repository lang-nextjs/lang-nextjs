# The .py plane, mapped to requirements (#583)

**Record only. No matrix edits.** What follows is what exists, function by function,
keyed on what each one ASSERTS rather than on what it is called.

## Population, established before anything was read

Two independent searches agree, and they disagree with the issue by one file:

|                                           |                                    |
| ----------------------------------------- | ---------------------------------- |
| python files containing `test*` functions | **14** (issue says 15)             |
| python test functions                     | **81** (issue's number, confirmed) |
| requirement rows in PROJECT.md            | **35 live** (37 unique, 2 retired) |
| live rows saying "verified by"            | 24                                 |
| live rows naming a `.ts`/`.tsx` file      | 25                                 |
| rows citing a `.py` test                  | **0** (issue's number, confirmed)  |

My first count said 39 rows. That was the number of `**ID**` MENTIONS, not rows —
two IDs appear twice and two more (`PKG-03`, `PKG-04`) are retired. Recording the
correction because a denominator taken from a regex that answered a slightly
different question is the shape of defect this whole exercise is about.

The first search globbed `test_*.py` / `*_test.py`; the second walked every `.py`
under both backends and parsed it, keeping any file with a `test*` function. Both
return the same 14 files. A name-keyed search finding the same answer as a
content-keyed one is worth stating, because a name-keyed search is what produced
the `E2E-01` bucket that outlived its evidence.

**The plane is not symmetric and the label hides it.** `django-backend` has ONE
test file with 4 functions. The other 77 are FastAPI. "The .py plane has 81 tests"
is true and reads as though both runtimes are covered; one of them has four.

## My reach, so this pass can be checked

- **81 of 81** read to their assertions.
- 76 via extracted `assert` expressions and `assertX(...)` calls.
- **5 had zero extractable assertions** and were read directly: four use
  `pytest.raises(...)` and one asserts that `CancelledError` PROPAGATES. My
  extractor could not see any of them. Had I trusted the extractor's count I would
  have recorded five tests as asserting nothing, which is the false-negative
  version of the defect this exercise is about.
- I did **not** run the suite. Every verdict below is from reading, not from
  observed behaviour.

## The finding: ADAPT-05 has behavioural evidence and does not cite it

`ADAPT-05` — _"Approval gating: `data-approval-required` frame; the STREAM pauses
until an explicit approval or rejection"_ — is the row #453 found marked SATISFIED
on the evidence that three symbols are exported. It is marked ⚠ in PROJECT.md and
cites nothing.

**Twenty-eight python functions across four files assert exactly that claim**, and
the strongest of them is the file #453 quotes as its model of good evidence:

| file                                 | fns | what the assertions actually establish                                                                                                             |
| ------------------------------------ | --- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test_approval_withholds.py`         | 5   | `effects[0] == 0` while gated, `== 1` after approve. The SIDE EFFECT, with an ungated control arm proving the harness can observe execution at all |
| `test_gated_run_frame_invariants.py` | 3   | A gated run never closes having emitted neither a result nor a pause; and the round trip composes — pause out, decision in, tool runs              |
| `test_gated_emits_no_tool_frames.py` | 2   | A gated run emits no tool frames; an ungated control does                                                                                          |
| `test_approval_dispatch.py`          | 18  | approve/reject/respond/edit each produce their distinct outcome; unknown decisions and lost threads are REFUSED rather than swallowed              |

`test_approval_withholds.py` is the artifact #453 promotes: _"0 effects is equally
consistent with a harness that never ran the agent at all, and a suite that cannot
tell those apart reports the same green for both."_ It carries the control arm that
sentence demands. **It is not cited by the requirement it proves.**

That is the specific, actionable result of this pass: the row that was closed by an
existence check has had behavioural evidence sitting in another language plane the
whole time.

## Everything else: no row claims it

The remaining 53 functions assert real properties that **no requirement row
mentions**. That is a fine answer — the point was that nobody had asked — but the
list is worth having, because each is a candidate for a row that does not exist:

| file                                     | fns | subject                                                                                    | nearest row                    |
| ---------------------------------------- | --- | ------------------------------------------------------------------------------------------ | ------------------------------ |
| `test_approval_policy_wire.py`           | 10  | policy parsing: absent/malformed/empty allowlists, and that an unknown tool is GATED       | none — adjacent to ADAPT-05    |
| `test_trace_axes.py`                     | 8   | langfuse tags per runtime/framework/topology, no leakage between concurrent requests       | none                           |
| `test_stream_error_reporting.py`         | 6   | the provider's reason survives to the client; the stream still ends like a finished stream | none                           |
| `test_response_wire_format.py` (fastapi) | 5   | `text/event-stream`, anti-buffering headers, 404s that name the valid options              | **not SRV-02** — see below     |
| `test_run_session.py`                    | 5   | session id is an identity not a tag; absent means no key                                   | none                           |
| `test_cors_allowlist.py`                 | 5   | the env REPLACES the dev default rather than extending it                                  | none                           |
| `test_response_wire_format.py` (django)  | 4   | same shape, plus a control that a non-stream route is JSON                                 | none                           |
| `test_error_origin.py`                   | 4   | provider vs backend attribution, and that `code` alone cannot separate them                | none — this is #433's property |
| `test_tool_announcements.py`             | 3   | see the caveat below                                                                       | none                           |
| `test_turn_usage.py`                     | 3   | usage reaches the finish frame; a provider reporting nothing claims nothing                | none                           |

### `SRV-02` is the near-miss, and it does not hold

`SRV-02` is _"SSE proxy with `x-vercel-ai-ui-message-stream: v1` header"_. Both
`test_response_wire_format.py` files look like they cover it — they assert
`text/event-stream`, `cache-control: no-cache`, `x-accel-buffering: no`. **None of
them asserts the `x-vercel-ai-ui-message-stream` header.** Keyed on the filename
this row looks covered by the .py plane; keyed on the assertions it is not. This is
the trap the issue names, found in the population rather than assumed.

### `test_tool_announcements.py` asserts on SOURCE TEXT, not behaviour

All three functions assert string membership in the module's own source:

```
"if not parsed.strip():" in src
'buf["id"] != chunk_id' in src
"except json.JSONDecodeError:" in src
```

They pass against code that is never executed, and they fail on a refactor that
preserves behaviour exactly. Whatever they are evidence of, it is not that the
behaviour holds — so they should not be cited by any row, and are listed here so
nobody cites them later on the strength of their names.

## What this pass does NOT establish

- That the 28 ADAPT-05 functions PASS. I read them; I did not run them.
- That the other 53 have no requirement — only that no row in PROJECT.md names
  their subject. A row that should exist is a different finding from a row that
  does.
- Anything about tests added after this was written. #550 is with DEV5 and will
  add `.py` tests to both planes; new arrivals are theirs to cite.

---

# Addendum: what is actually citable today (#583, after #555)

## The syntax is not the blocker — measured, both directions

`traceability.mjs` resolves a citation by `existsSync(path)` then
`fileSrc.includes(testName)`. That is language-agnostic, and it works on `.py`:

| probe (in a sandbox root, PROJECT.md untouched) | result                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| valid `.py` citation on a ✓ row                 | resolves — the only complaint is `STALE ALLOWLIST`, i.e. bookkeeping |
| broken `.py` citation on a ✓ row                | `BROKEN CITATION: … contains no test named "test_NOPE_NOT_REAL"`     |

So the checker opens the Python file and looks inside it. **"The syntax cannot
express a .py citation" is false.**

### The ⚠ row is not checked at all, and I nearly proved the opposite

My first probe put a `.py` citation on `ADAPT-05` and the checker passed. That
proved nothing: `ADAPT-05` is the only ⚠ row, and the gate validates ✓ rows.
Breaking the same citation deliberately ALSO passed — which is how I found out.
The positive control had to move to a ✓ row before either result meant anything.

**ADAPT-05 is outside the traceability gate entirely.** That is worth more
attention than its missing citation: the one row known to have been closed on bad
evidence is the one row no checker inspects.

## How many uncited rows become citable with a `.py` test: ZERO

Ten live rows are uncited. Against the map above, none of them describes a
property the `.py` plane proves:

| row                     | why not                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PKG-01, PKG-02, RCT-04  | packaging and peer deps — no runtime evidence in either plane                                                                                                                                                             |
| SRV-01, ADAPT-02, DX-03 | TypeScript API surface                                                                                                                                                                                                    |
| DASH-02, CI-01          | open-swe route and the CI job                                                                                                                                                                                             |
| **SRV-06**              | _near-miss_: "502 on unreachable backend, 500 on mid-stream error". The `.py` tests assert **404** for an unknown backend and a `data-error` frame mid-stream. A different contract, not weaker evidence for the same one |
| **ADAPT-05**            | see below — the 28 functions must NOT be cited here                                                                                                                                                                       |

**So the binding constraint is not expressiveness. It is that no row describes
what the `.py` plane does.** #583 is neither "the .py plane is untested" (this
audit disproves that) nor an expressiveness gap (the syntax works). It is a ROW
gap.

## Why the 28 must not be cited on ADAPT-05

ADAPT-05's row now reads, correctly: _"The run does NOT pause — the tool executes
upstream and the transform withholds its frames, not its effect."_ That is a true
statement about the **proxy** gate in `packages/server`.

`test_approval_withholds.py` says so itself, in its own header, and exists as the
COUNTER to it: _"Today's approval gate lives in the proxy, downstream of the
backend that already ran the tool… dropping the frames withholds the REPORT, not
the effect."_ Its 28 sibling functions assert `effects == 0` while gated and
`== 1` after approval — a **different gate**, in the backend, which genuinely
withholds execution.

Citing them on ADAPT-05 would attach true evidence about one mechanism to a row
about another. **That is ADAPT-05's original defect in a subtler form** — the
first version cited evidence that was true and about exports; this would cite
evidence that is true and about the other plane's gate.

**The residual shape is a new row**, not a new citation syntax: something like
"the backend-side gate withholds execution until a decision", which the 28 prove
directly.

## And that new row would inherit the asymmetry

`django-backend` has four test functions, all in `test_response_wire_format.py`.
**It has no approval tests at all.** So a row worded "the Python plane withholds
execution", cited by `apps/fastapi-backend/tests/…`, would claim a property for
two runtimes on evidence from one — the same move as ADAPT-05's export evidence,
one plane over. Either the row names FastAPI, or django needs the tests first.

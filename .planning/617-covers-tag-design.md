# #617 — a `@covers` tag, and what a checker can and cannot do with it

Design note. No scheme is landed; this records what was measured, which of the
four proposed properties survive contact with real rows, and where the residual
human judgement sits so it is scoped rather than implied.

## The conclusion first

**Reversing the link is right and the tag is worth adding.** It fixes the ~13
"same behaviour described two ways" rows, which no search can fix.

**The mechanical verification of a tag is worth much less than it looks, and I
can show why rather than assert it.** A rule strong enough to reject SRV-06 also
rejects tests that genuinely cover their row; a rule weak enough to accept those
also accepts SRV-06. I tuned across three iterations and each one fixed one real
case and broke another. That is curve-fitting to four examples, and with 44
heterogeneous free-text rows it will misclassify — asymmetrically, in the
dangerous direction.

## Property 1 — "the check compares VERBS" — CHALLENGED

Verbs are the worst available handle. "pauses", "withholds", "gates" and "holds"
are the same behaviour, and a criterion's verb rarely appears in a test at all.

What is comparable is **subject tokens**: literals and identifiers a criterion
names. SRV-06 is not caught by a verb; it is caught by the literal `500`.

## Property 2 — "a case proving it REJECTS a wrongly-tagged test" — AGREED, AND USE SRV-06 ITSELF

SRV-06 is a live, committed instance, which beats a synthetic fixture: a
synthetic one proves the checker rejects what the author designed it to reject.
Measured against the real row and the real test:

    criterion : 502 on unreachable backend, 500 on mid-stream error
    tokens    : 502, 500, mid-stream
    assertions: expect(consoleSpy).toHaveBeenCalled()
    verdict   : REJECT — no assertion mentions any outcome the criterion names

## Property 3 — "both directions" — AGREED, and cheap

A tag naming a row that does not exist, and a row with no tagged test, are both
set-difference over two enumerable populations. This is the same shape as
`accountedFor` in `scripts/readme-quickstart.mjs` and needs no new thinking.

Note one hazard found while surveying: **the tag namespace already collides.**
18 test files carry `(XXX-NN)` in a test name, and among them are `SPEC-09`,
`SPEC-05`, `SPEC-06` — the SUITE's own ids, not requirement ids. A scheme keyed
on a bare parenthesised id would read those as requirement tags. That is the
E2E-01/SPEC-01 collision again, so the tag needs a distinct marker: `@covers
SRV-06` in a comment, never a bare id in a title.

## Property 4 — "the tag is not its own evidence" — NOT SOLVABLE, AND HERE IS THE PROOF

Three iterations, each fixing one real case and breaking another:

| rule                                                                                           | SRV-06 (must reject)            | SRV-05       | SRV-04   | SRV-02       |
| ---------------------------------------------------------------------------------------------- | ------------------------------- | ------------ | -------- | ------------ |
| tokens must appear in an **assertion**                                                         | REJECT ✓                        | **REJECT ✗** | accept ✓ | accept ✓     |
| tokens must appear **anywhere in the body**                                                    | **accept ✗** (via "mid-stream") | accept ✓     | accept ✓ | accept ✓     |
| token **class** decides scope: outcome literals in assertions, subject identifiers in the body | REJECT ✓                        | accept ✓     | accept ✓ | **REJECT ✗** |

- SRV-05's criterion names a CLASS, which appears in the test's setup rather
  than its assertions — so assertion-scoping rejects a test that does cover it.
- SRV-06's body contains "mid-stream" in an `Error` message — so body-scoping
  accepts the exact test the scheme exists to reject.
- SRV-02's criterion backticks `x-vercel-ai-ui-message-stream: v1`, a
  name-and-value pair, which no assertion contains as one string.

A fourth iteration splitting colon-pairs would fix SRV-02 and I stopped there,
because the pattern is the point: **each refinement is fitted to the examples in
front of it.**

### The asymmetry that makes this dangerous

A false REJECT is loud — someone investigates and fixes it. A false ACCEPT is
silent and it terminates the search, which is precisely SRV-06's damage today. A
rule tuned on four examples will produce both, and only one of them will ever be
noticed.

## What the checker should actually do

Rungs of decidability, cheapest first. Everything through 4 is mechanical;
5 and 6 are not, and the checker must say so rather than imply it.

1. the tag resolves to a real row — **mechanical, exact**
2. every ✓ row has at least one tagged test — **mechanical, exact**
3. the tagged test contains at least one assertion — **mechanical, exact**
4. when the criterion names a NUMERIC OUTCOME (a status code), some assertion
   in the tagged test mentions it — **mechanical, narrow, and the only token
   class where I could not construct a false positive**
5. the test's assertions are about the criterion's behaviour — **human**
6. the test has been observed failing when the behaviour is broken — **human,
   and the strongest thing this repo does**

Rung 4 catches SRV-06. It is deliberately narrower than "compare subjects",
because numeric outcomes are the one class where the criterion's token and the
assertion's token are the same string with no synonym problem.

## What this buys, stated without inflation

- the ~13 unfindable rows become findable — the actual goal
- SRV-06's shape becomes a hard failure
- a row losing its last tagged test becomes a hard failure
- **it does not establish that a tagged test proves its row.** Rungs 5 and 6
  remain human. The checker's output must name what it verified, so a green
  reads as "the tag resolves, the test asserts something, and any numeric
  outcome named by the row is asserted" — never as "covered".

If the output says "covered", the scheme has rebuilt SRV-06 with a gate over it.

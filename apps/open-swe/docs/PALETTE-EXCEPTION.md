# Why `apps/open-swe` is excluded from `check-palette`

> ## ⚠️ SUPERSEDED — the debt this document bounds is now ZERO
>
> **`node scripts/check-palette.mjs apps/open-swe` → `clean — no hardcoded Tailwind
> palette on a themed surface.`** The app was converted onto `@deepagents-nextjs/ui`
> and the design-system tokens: 237 findings → **0**, 9 files → **0**.
>
> **Everything below this banner describes a state that no longer exists.** Every
> "237", every per-file count, and the whole cost argument for deferring the
> conversion are historical. They are kept rather than deleted because the
> *reasoning* — why an exclusion is preferable to a check somebody switches off,
> and why `AgentModeBanner`'s colours carry a correctness property rather than a
> cosmetic one — is what made the ratchet the right instrument at the time, and
> that argument outlives its numbers.
>
> **The correctness property was preserved, not flattened.** `AgentModeBanner`'s
> three provenance tones are still three distinct tokens — `warning` (scripted),
> `success` (live), `muted-foreground` (unknown) — and the state remains in the
> DOM as `data-agent-mode`, so nothing depends on colour to tell them apart.
>
> **What is still open:** the exclusion itself. With zero debt there is nothing
> left to bound, so `apps/open-swe` should be promoted into `check-palette`'s
> `DEFAULT_ROOTS` and this ratchet retired. That is deliberately a separate
> change — see `_nextStep` in `palette-baseline.json`.

**Decision (historical): keep the exclusion, and ratchet it.** Not "adopt the theme
now", and not "exclude and forget". Reasoning below is measured, not estimated, and
the removal condition is falsifiable.

## What is actually there

`node scripts/check-palette.mjs apps/open-swe` → **237 findings across 9 files**:

| File | Findings |
|---|---|
| `app/runs/[runId]/page.tsx` | 55 |
| `app/chat/page.tsx` | 54 |
| `app/page.tsx` | 34 |
| `components/ChatWorkspace.tsx` | 30 |
| `components/RunListCard.tsx` | 23 |
| `components/ConversationView.tsx` | 19 |
| `components/AgentModeBanner.tsx` | 12 |
| `components/DemoNav.tsx` | 9 |
| `app/layout.tsx` | 1 |

By hue: `neutral` 148 · `red` 28 · `emerald` 28 · `amber` 17 · `blue` 15 · `indigo` 1.

## Why not adopt now

**1. It is a theme migration, not a class swap.** `apps/example` gets tokens by
importing `@deepagents-nextjs/ui/globals.css`, which imports `@digitalfrontier/theme`.
`apps/open-swe/app/globals.css` does not — it defines its own near-black dashboard
theme. 62% of the findings are `neutral-*`: that is the app's visual identity, chosen,
not drift.

**2. There is no visual regression coverage for this app.** The `visual` Playwright
project matches `shared/visual.spec.ts` only. Converting 237 colour classes here would
be a large visual change whose only regression detector is somebody looking at it.

**3. ~~The banner's three states may not be expressible in tokens.~~ ANSWERED — NOT A
BLOCKER.** Kept here because three of us wrote this doubt down independently and none of
us had checked it. Do not re-derive it.

`AgentModeBanner` uses amber / emerald / neutral for *scripted* / *live* / *unknown*
provenance — the mechanism that stops a forker mistaking a scripted run for a real
agent. Two questions were conflated, and both are now settled:

**Availability — settled.** All three states have Tailwind-usable aliases in
`@digitalfrontier/theme` (pinned `e4c176c`), and `apps/example` renders all of them
while passing `check-palette`, which is a behavioural proof rather than a grep:

| Banner state | Token | Alias | Live usage in `apps/example` |
|---|---|---|---|
| scripted | `--warning` → `--df-warn` | `--color-warning` | `bg-warning` ×4, `border-warning` ×2 |
| live | `--success` → `--df-good` | `--color-success` | `bg-success` ×2 |
| unknown | `--muted` / `--muted-foreground` | `--color-muted`, `--color-muted-foreground` | `bg-muted` ×5, `text-muted-foreground` ×13 |

**Distinguishability — measured (DEV7).** Pairwise oklab ΔE between the three states:

| Pair | DF tokens | Ships today |
|---|---|---|
| warning vs success | 0.181 | 0.212 |
| warning vs muted | 0.176 | 0.204 |
| success vs muted | 0.162 | 0.164 |
| **worst pair** | **0.162** | **0.164** |

The DF triple is **0.99×** the separation of the current design — a 1% difference on the
worst pair, both roughly 8× the ~0.02 just-noticeable-difference threshold. The tightest
pair is the same one in both palettes (live vs unknown).

**And colour is not the only channel.** The banner is `role="status"`, the dot is
`aria-hidden="true"`, and the state is carried in text (`{label}`). WCAG 1.4.1 is
satisfied today and a re-hue cannot break it. The remaining risk is purely visual.

**So this reason no longer supports the decision.** It is recorded as answered, and the
decision rests on reasons 1 and 2 — reason 2 sufficing on its own.

> What the ΔE numbers do **not** settle: the tinted backgrounds and text at their
> various alphas (`bg-amber-500/10`, `text-amber-200`), how they sit on this app's
> canvas, and whether the converted banner looks *right* as opposed to *different
> enough*. "Can these be told apart" is answerable with a calculator; "will the
> conversion regress" is not. That is what removal condition 2 detects.

## Why not a plain exclusion either

The exclusion silently grows. `AgentModeBanner.tsx` contributed **12** of the 237 and was
added *after* the exclusion was written — and nothing objected, because **an excluded
path cannot fail.**

This is structural, not anybody's oversight. The exclusion did the only thing an
exclusion can do; the file was added by someone who did not know they were writing into
an excluded path. A blanket exclusion converts a known, bounded debt into an unbounded
one, and no amount of care by either party changes that.

## The ratchet

Record the count. Fail if it goes **up**.

```
node scripts/check-palette.mjs apps/open-swe   # advisory: must not exceed baseline
```

Baseline: **237** findings / **9** files.

Measured at `06725a6`, and **re-verified at `164839b`** — `apps/open-swe` is untouched
between the two (`git diff 06725a6..164839b -- apps/open-swe` is empty), and a fresh
scan returns the same 237/9. The pin held; it was checked rather than assumed.

This keeps the excluded area from getting worse without reporting 237 known findings as
failures — the "check that cries wolf" problem the exclusion exists to avoid.

## Condition for removal

Add `apps/open-swe` to `DEFAULT_ROOTS` when **both** hold:

1. `apps/open-swe/app/globals.css` imports the shared token sheet — today it imports
   plain Tailwind and defines its own theme, so the tokens, though *available* in the
   package, do not resolve in this app; **and**
2. the `visual` Playwright project covers, at minimum, the dashboard, a run detail page,
   and all three `AgentModeBanner` states — so a conversion regression fails a test
   rather than requiring an eye.

Until both hold, converting would trade a visible, bounded, documented inconsistency for
an invisible, unbounded risk to a correctness-bearing UI.

# A false RED: turbopack's dev cache under rapid file cycling

**If you are mutation-testing — editing a file, running a check, restoring it, and
repeating — `apps/example` can start failing on files you did not touch, and on
files you correctly restored. Clear `apps/example/.next` before you believe a red.**

```bash
# Kill by PORT, not by pattern: `pkill -f "next dev"` also kills apps/open-swe,
# and in a shared checkout it kills whatever anyone else is running.
lsof -nP -iTCP:3000 -sTCP:LISTEN -t | xargs -r kill

rm -rf apps/example/.next    # usually the part that fixes it
```

**And when that does not fix it, a production build does:**

```bash
pnpm --filter example build && pnpm --filter example start
```

**If `rm -rf .next` failed to clear it, that is NOT evidence the failure is
real.** It is the single most expensive wrong conclusion available here, and it
is the one the rest of this document used to lead you to — see
[How to tell it apart](#how-to-tell-it-apart-from-a-real-regression), which was
wrong about exactly this and has been corrected.

## Why this is worth a document

Most of the failure modes this repo has hunted are gates that **cannot fail** —
a check that passes over nothing and reports a confident green. This is the rarer
opposite: a **false red**. A correct tree looks broken.

That direction is more dangerous than it sounds. A green over nothing gets caught
eventually by someone asking "what did that actually prove?". A red on correct
code invites you to "fix" something that was never wrong — and the obvious repair
for a red gate is to weaken the gate.

## What it looks like

Two spellings observed, both after cycling files at speed:

**CSS**, after cycling `packages/ui/src/styles/globals.css`:

```
CssSyntaxError: tailwindcss: apps/example/app/globals.css:1:1:
  Cannot apply unknown utility class `border-border`
```

Reads exactly like the design tokens are not wired up. They are.

**Routes**, after cycling `apps/example/app/layout.tsx`:

```
Persisting failed: Another write batch or compaction is already active
  (Only a single write operations is allowed at a time)
Error: ENOENT: no such file or directory, open
  '.../.next/dev/server/app/hitl-demo/page/build-manifest.json'
```

`/hitl-demo`, `/concurrent-test` and `/reconnect-test` return **500** while `/`
and `/dashboard` serve **200** — routes unrelated to the edit, in a tree whose
files are byte-correct. The e2e a11y gate then reports three failures with
DEV5's route guard firing correctly on a genuine non-200.

**Hydration**, in `apps/open-swe` — the nastiest spelling, because nothing looks
wrong:

```
/          200        every route serves
/runs/x    200        every JS chunk serves 200
                      no page errors, no console exceptions, HTML fully rendered
```

The page renders and is completely inert. React never hydrates: no `useEffect`
runs, so no client fetch is ever issued; a list sits on "loading…" forever;
typing into a composer does not enable a button gated on its value. The only
console signal was an HMR websocket handshake failure, which is **not** a
reliable tell (see below).

**This is the one to watch for, because every cheap check passes.** The
status-code loop at the bottom of this document reports all-200 and tells you
nothing. `git status` is clean. The build log is clean. The only thing that is
wrong is that the app is dead, and you find that out through whichever assertion
happened to depend on client behaviour.

Concretely: the open-swe e2e suite reported **19 failed / 0 passed**. Under a
production build of the same commit it reported **15 failed / 4 passed** —
which matched CI exactly. Four of those "failures" were specs that were never
broken, and the other fifteen were real. A baseline that wrong is worse than no
baseline: it invites you to fix specs that are correct.

## The other trigger: `next build` while `next dev` is running

`next build` and `next dev` share the same `apps/example/.next` directory, so a
build run against a live dev server **rewrites the state that server is reading**.
The dev server then serves **404** for routes that exist in the source:

```
/                  200
/hitl-demo         404      <- exists in the source, gone from the dev server
/concurrent-test   404
/reconnect-test    404
/dashboard         200
```

This is easy to do by accident in a verification sweep — run the e2e suite
against the dev server, then run `next build` in the same script, then run
anything else against that server. Everything after the build is measuring a
degraded server, and the a11y gate reports failures with DEV5's route guard
firing correctly on a real non-200.

**Order the sweep so the build comes first, or stop the dev server around it:**

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN -t | xargs -r kill   # by port, not by pattern
pnpm --filter example exec next build     # build with nothing serving
# start dev, wait for every route to serve 200, THEN run e2e
```

## How to tell it apart from a real regression

**We do not know a cheap way to tell these two states apart. The trial is the
diagnostic.** Stop looking for a shortcut and run the prod build; that is the
honest answer, and knowing it is the answer saves more time than hunting for a
better one.

This section previously said the tell was that *"restarting the dev server does
not clear it. A real regression survives `rm -rf .next` too; this does not."*
**That is false, and it was the most costly sentence in this document.** A stale
cache can survive `rm -rf .next`, observed in `apps/open-swe`: cleared the
directory, restarted, still dead; `next build && next start` on the same commit
worked. Anyone applying the documented remedy, seeing red again, and following
that sentence would conclude the failure was genuine. It converts *"I have not
fixed it yet"* into *"it is not the cache"* — which is exactly the wrong
handrail, because a remedy that works most of the time is worse than none.

The escalation, in order:

```bash
git status --porcelain          # 1. confirm the tree is actually restored
lsof -nP -iTCP:$PORT -sTCP:LISTEN -t | xargs -r kill
rm -rf apps/<app>/.next         # 2. usually enough
# restart, wait for every route to serve 200, then re-run

pnpm --filter <app> build && pnpm --filter <app> start   # 3. when it is not
```

If step 3 passes and step 2 did not, it was the cache — full stop, regardless of
how real the red looked. Only if the failure survives a **production build of a
clean tree** is it yours.

Confirm all routes serve before trusting any suite result — necessary, but
**not sufficient**: the hydration spelling above serves 200 everywhere while
being completely inert, so this loop is silent on the worst case.

```bash
for r in / /hitl-demo /concurrent-test /reconnect-test /dashboard; do
  printf "%-18s " "$r"; curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:$PORT$r"
done
```

### What is not a tell

- **The HMR websocket error** (`ERR_INVALID_HTTP_RESPONSE` on
  `/_next/webpack-hmr`) was present in the inert-hydration case, but nobody has
  checked whether a healthy dev server also logs it. Do not treat it as a
  signal until someone does.
- **A clean build log and a clean `git status`.** Both were clean throughout.
- **Route status codes.** See above.

## Who this is for

Anyone cycling config or source in a loop: lighthouse configs, Next version
bumps, CSS token work, or mutation-testing an assertion to prove it can fail.
Mutation-testing is the practice most likely to hit this, because rapid
edit/restore cycling is exactly what it does — and proving a check can fail is
worth keeping, so budget the cache clear rather than dropping the practice.

It is also not confined to `apps/example`: the hydration spelling was found in
`apps/open-swe`. Read every `apps/example/.next` path here as `apps/<app>/.next`.

Found while adopting `@digitalfrontier/theme` (#44b), mutation-checking the
themed-render guard in `e2e/accessibility.spec.ts`. Extended from #22, where the
open-swe e2e baseline was wrong by four specs until the dev server was taken out
of the loop — and where `rm -rf .next` was tried first and did not help.

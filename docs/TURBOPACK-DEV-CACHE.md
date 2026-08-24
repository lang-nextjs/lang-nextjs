# A false RED: turbopack's dev cache under rapid file cycling

**If you are mutation-testing — editing a file, running a check, restoring it, and
repeating — `apps/example` can start failing on files you did not touch, and on
files you correctly restored. Clear `apps/example/.next` before you believe a red.**

```bash
pkill -f "next dev"          # a restart alone is NOT enough
rm -rf apps/example/.next    # this is the part that fixes it
```

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
pkill -f "next dev"
pnpm --filter example exec next build     # build with nothing serving
# start dev, wait for every route to serve 200, THEN run e2e
```

## How to tell it apart from a real regression

The tell is that **restarting the dev server does not clear it.** A real
regression survives `rm -rf .next` too; this does not.

```bash
git status --porcelain          # confirm the tree is actually restored
rm -rf apps/example/.next
# restart, wait for every route to serve 200, then re-run
```

Confirm all routes serve before trusting any suite result:

```bash
for r in / /hitl-demo /concurrent-test /reconnect-test /dashboard; do
  printf "%-18s " "$r"; curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:$PORT$r"
done
```

## Who this is for

Anyone cycling config or source in a loop: lighthouse configs, Next version
bumps, CSS token work, or mutation-testing an assertion to prove it can fail.
Mutation-testing is the practice most likely to hit this, because rapid
edit/restore cycling is exactly what it does — and proving a check can fail is
worth keeping, so budget the cache clear rather than dropping the practice.

Found while adopting `@digitalfrontier/theme` (#44b), mutation-checking the
themed-render guard in `e2e/accessibility.spec.ts`.

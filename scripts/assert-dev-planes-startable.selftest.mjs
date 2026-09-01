#!/usr/bin/env node
/**
 * PROOF THAT THE DEV-PLANE CENSUS CAN FAIL (#633).
 *
 * The gate it guards is unusual in this repo: dev-all.sh is run by people, not by CI, so the
 * defect it catches has never had anything watching for it. That makes the "can it fail" proof
 * matter more than usual, not less — nothing else in the pipeline would notice this check going
 * quietly green.
 *
 * Every case drives check() with a synthetic manifest and a synthetic script, so it needs no
 * docker, no containers and no model key. The real tree is asserted once at the end.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { check, declaredRuntimes } from "./assert-dev-planes-startable.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;
const t = (label, ok, detail = "") => {
  if (ok) {
    console.log(`  ok   ${label}`);
    pass++;
  } else {
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
};

const manifest = (ids) =>
  JSON.stringify({
    rungs: [
      {
        runtimes: Object.fromEntries(
          ids.map((id) => [id, { topologiesSource: `apps/${id}-backend/x.py` }])
        ),
      },
    ],
  });

/** A script that starts, probes and stops each named plane. */
const scriptFor = (ids) =>
  ids
    .map(
      (id) =>
        `if [ "$WITH_${id.toUpperCase()}" = "1" ]; then\n` +
        `  (cd "$ROOT/apps/${id}-backend" && docker compose up -d --wait)\n` +
        `  wait_for "http://localhost:$PORT/health" 90 "${id}"\n` +
        `fi\n` +
        `  "apps/${id}-backend:${id}"\n`
    )
    .join("\n");

const REAL = ["django", "fastapi", "node"];

t(
  "a script that starts, probes and stops every declared runtime is ACCEPTED",
  check(manifest(REAL), scriptFor(REAL)).length === 0,
  JSON.stringify(check(manifest(REAL), scriptFor(REAL)))
);

/*
 * THE #633 CASE ITSELF: the manifest declares three, the script knows two. This is the exact
 * shape main was in — node had a compose file, a dev script and a /health endpoint, and
 * `grep -c node-backend scripts/dev-all.sh` was 0.
 */
{
  const p = check(manifest(REAL), scriptFor(["django", "fastapi"]));
  t(
    "a declared runtime the script never mentions is REFUSED",
    p.some((x) => /never mentions apps\/node-backend/.test(x)),
    JSON.stringify(p)
  );
}

{
  // Started, but never asked whether it came up.
  const s =
    scriptFor(["django", "fastapi"]) +
    `\n(cd "$ROOT/apps/node-backend" && docker compose up -d)\n  "apps/node-backend:node"\n`;
  const p = check(manifest(REAL), s);
  t(
    "a runtime started with no probe is REFUSED",
    p.some((x) => /no wait_for probe for "node"/.test(x)),
    JSON.stringify(p)
  );
}

{
  // Started and probed, but nothing stops it — the state django was in before #633.
  const s =
    scriptFor(["django", "fastapi"]) +
    `\nif [ "$WITH_NODE" = "1" ]; then\n` +
    `  (cd "$ROOT/apps/node-backend" && docker compose up -d --wait)\n` +
    `  wait_for "http://localhost:$NODE_PORT/health" 90 "node"\nfi\n`;
  const p = check(manifest(REAL), s);
  t(
    "a runtime that can be started and never stopped is REFUSED",
    p.some((x) => /can start apps\/node-backend but never stops it/.test(x)),
    JSON.stringify(p)
  );
}

/*
 * THE FALSE POSITIVE THIS CHECK PRODUCED BEFORE IT WAS RIGHT, kept so it cannot come back.
 *
 * The probe was first located by NAME — a wait_for mentioning the runtime id or <ID>_PORT — and
 * that reported fastapi as unprobed. fastapi is probed; its variables are BACKEND_PORT and its
 * label is "backend", because it is the default plane and predates the naming the others use.
 * The check was measuring a convention and reporting a missing probe. Locating the probe
 * POSITIONALLY is the repair, and this fixture pins it: a plane whose probe shares no words
 * with its id must still be accepted.
 */
{
  const s =
    `if true; then\n  (cd "$ROOT/apps/fastapi-backend" && docker compose up -d)\n` +
    `  wait_for "http://localhost:$BACKEND_PORT/health" 90 "backend"\nfi\n` +
    `  "apps/fastapi-backend:fastapi"\n`;
  const p = check(manifest(["fastapi"]), s);
  t(
    "a probe named nothing like its runtime is still recognised (fastapi/BACKEND_PORT)",
    p.length === 0,
    JSON.stringify(p)
  );
}

t(
  "a manifest declaring ZERO runtimes REFUSES rather than passing vacuously",
  check(JSON.stringify({ rungs: [] }), scriptFor(REAL)).some((x) =>
    /declares ZERO runtimes/.test(x)
  )
);

/* ── and the real tree ────────────────────────────────────────────────────────────────────── */
{
  const ids = [
    ...declaredRuntimes(readFileSync(join(ROOT, "rungs.json"), "utf8")),
  ];
  t(
    "the real manifest declares more than one runtime (a census of one proves little)",
    ids.length > 1,
    `declared: ${ids.join(", ")}`
  );
  const p = check(
    readFileSync(join(ROOT, "rungs.json"), "utf8"),
    readFileSync(join(ROOT, "scripts", "dev-all.sh"), "utf8")
  );
  t(
    "the real dev-all.sh can start every declared runtime",
    p.length === 0,
    p.join(" | ")
  );
}

const total = pass + fail;
if (fail !== 0) {
  console.error(`\nFAIL: ${fail}/${total} cases wrong.`);
  process.exit(1);
}
console.log(
  `\nPASS: ${pass}/${total}. The census refuses a declared runtime the script never mentions,\n` +
    `      one started without a probe, and one that can be started and never stopped — and it\n` +
    `      accepts a plane whose probe shares no words with its id, which an earlier version\n` +
    `      wrongly reported as unprobed.`
);

#!/usr/bin/env node
/**
 * Proves check-langfuse-wiring.mjs fails on an unwired site, a DELETED site, a
 * missing source file, and a subject-less run — and passes on a correct tree.
 *
 * CI runs this immediately BEFORE the real check (#116: every checker CI runs
 * must have a proof CI runs). A checker never observed to fail is
 * indistinguishable from one that cannot fail.
 */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  cpSync,
  readdirSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkWiring,
  checkLockstep,
  checkNoSecretLiterals,
  checkSubjectTotality,
  checkPromptParity,
  codeOnly,
} from "./check-langfuse-wiring.mjs";

const REAL = process.argv[2] || process.cwd();
const RT = [
  "apps/fastapi-backend/ai_backends",
  "apps/django-backend/deepagents_backend/ai_backends",
];
const NODE_OBS = "apps/node-backend/src/common/observability.ts";
const FIX = [
  "scripts/langfuse-local/docker-compose.yml",
  "scripts/langfuse-local/backend-override.yml",
];
const REQ = [
  "apps/fastapi-backend/requirements.txt",
  "apps/django-backend/requirements.txt",
];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "lfwire-"));
  for (const rt of RT) {
    mkdirSync(join(dir, rt), { recursive: true });
    cpSync(join(REAL, rt, "deepagents.py"), join(dir, rt, "deepagents.py"));
    cpSync(join(REAL, rt, "langgraph.py"), join(dir, rt, "langgraph.py"));
    cpSync(join(REAL, rt, "langchain.py"), join(dir, rt, "langchain.py"));
    cpSync(join(REAL, rt, "_common.py"), join(dir, rt, "_common.py"));
  }
  /*
   * rungs.json is the POPULATION the totality guard measures the literals against, and
   * observability.ts is the EVIDENCE node's exemption is verified with. A fixture without them
   * would make every totality case pass by having nothing to compare — the exact vacuity this
   * guard exists to close.
   */
  cpSync(join(REAL, "rungs.json"), join(dir, "rungs.json"));
  mkdirSync(join(dir, "apps/node-backend/src/common"), { recursive: true });
  cpSync(join(REAL, NODE_OBS), join(dir, NODE_OBS));
  mkdirSync(join(dir, "scripts/langfuse-local"), { recursive: true });
  for (const f of FIX) cpSync(join(REAL, f), join(dir, f));
  for (const r of REQ) {
    mkdirSync(join(dir, r.replace(/\/requirements\.txt$/, "")), {
      recursive: true,
    });
    cpSync(join(REAL, r), join(dir, r));
  }
  return dir;
}

/**
 * Fingerprint of the whole fixture: every path AND every byte. A deletion moves
 * it as surely as an edit does.
 */
function fingerprint(dir) {
  const h = createHash("sha256");
  const walk = (d, rel = "") => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const path = rel ? `${rel}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, path);
      else {
        h.update(path);
        h.update(readFileSync(full));
      }
    }
  };
  walk(dir);
  return h.digest("hex");
}

let pass = 0,
  total = 0,
  voided = 0;

/**
 * `want` is whether the checker should REJECT the fixture.
 *
 * A MUTATION THAT CHANGED NOTHING IS VOID, NOT A RESULT. Every mutation below is
 * a string or regex replace against real source, and any of them can silently
 * become a no-op when that source is reworded — the anchor stops matching and
 * `replace` returns the input unchanged. The checker then correctly accepts an
 * unmodified tree, this harness reports FAIL, and it ACCUSES A CHECKER THAT IS
 * WORKING PERFECTLY.
 *
 * That is not hypothetical here: an earlier revision of this file mutated
 * `def make_llm` -> `def make_llm_RENAMED`, and because the checker matched the
 * anchor by substring, the renamed form still matched, the two compared spans
 * were both wrong in the same way, and the case passed while proving nothing.
 * It also happened to classify.selftest.mjs, where django gaining deep-research
 * made the two topology lists equal and the mutation became an identity paste.
 *
 * So: fingerprint before and after. If a mutating case did not move the
 * fingerprint, report VOID and fail the suite — the proof is missing, and that
 * is a different fact from "the checker is broken".
 */
const expect = (want, label, fn, opts = {}) => {
  total++;
  const dir = fixture();
  try {
    const before = fingerprint(dir);
    fn(dir);
    const after = fingerprint(dir);
    const mutates = opts.mutates ?? want; // rejection cases must mutate
    if (mutates && before === after) {
      voided++;
      console.log(
        `  VOID ${label.padEnd(
          52
        )} (mutation changed NOTHING — proof missing, checker not implicated)`
      );
      return;
    }
    const { problems } = checkWiring(dir);
    const failed =
      [
        ...problems,
        ...checkLockstep(dir),
        ...checkPromptParity(dir),
        ...checkNoSecretLiterals(dir),
        ...checkSubjectTotality(dir),
      ].length > 0;
    if (failed === want) {
      pass++;
      console.log(
        `  ok   ${label.padEnd(52)} (${failed ? "rejected" : "accepted"})`
      );
    } else
      console.log(
        `  FAIL ${label.padEnd(52)} (${
          failed ? "rejected" : "accepted"
        }, wanted ${want ? "rejected" : "accepted"})`
      );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

expect(false, "an unmodified tree is accepted", () => {}, { mutates: false });

expect(true, "a site with config= stripped is rejected", (d) => {
  const f = join(d, RT[0], "langgraph.py");
  const src = readFileSync(f, "utf8");
  writeFileSync(f, src.replace(", config=langfuse_config()", ""));
});

expect(true, "THE ORPHAN (langchain planner) unwired is rejected", (d) => {
  const f = join(d, RT[0], "langchain.py");
  const src = readFileSync(f, "utf8");
  writeFileSync(
    f,
    src.replace(
      'planner.ainvoke({"input": user_text}, config=langfuse_config())',
      'planner.ainvoke({"input": user_text})'
    )
  );
});

expect(true, "a DELETED site is rejected (count is pinned)", (d) => {
  const f = join(d, RT[0], "langgraph.py");
  const src = readFileSync(f, "utf8");
  writeFileSync(
    f,
    src.replace(
      /async for event in graph\.astream_events\([\s\S]*?\):/,
      "if True:"
    )
  );
});

expect(true, "a MISSING source file is rejected, not skipped", (d) => {
  rmSync(join(d, RT[1], "langchain.py"));
});

expect(true, "an empty tree is rejected (zero subjects is vacuous)", (d) => {
  for (const rt of RT) rmSync(join(d, rt), { recursive: true, force: true });
});

/* ── subject totality: the literals must cover the world ──────────────────────────────────── */

expect(true, "a NEW adapter module in a checked plane is rejected", (d) => {
  writeFileSync(
    join(d, RT[0], "newrung.py"),
    "async def stream(m):\n    async for ev in graph.astream_events(m, version='v2'):\n        yield ev\n"
  );
});

expect(
  true,
  "a plane rungs.json declares but nothing checks is rejected",
  (d) => {
    const f = join(d, "rungs.json");
    const m = JSON.parse(readFileSync(f, "utf8"));
    for (const rung of m.rungs)
      if (rung.runtimes?.fastapi)
        rung.runtimes.go = {
          topologies: ["react"],
          topologiesSource: "apps/go-backend/ai_backends/langchain.go",
        };
    writeFileSync(f, JSON.stringify(m, null, 2));
  }
);

expect(
  true,
  "node claiming langfuse support while unchecked is rejected (stale exemption)",
  (d) => {
    const f = join(d, NODE_OBS);
    // AIM AT THE FIELD. The first `supported: false` in this file is inside a doc comment; a
    // mutation that hits prose leaves the declaration standing and proves nothing about it.
    const src = readFileSync(f, "utf8");
    const out = src.replace(
      /(langfuse:\s*\{[\s\S]{0,400}?supported:\s*)false/,
      "$1true"
    );
    if (out === src)
      throw new Error(
        "stale-exemption mutation matched nothing — the probe is void"
      );
    writeFileSync(f, out);
  }
);

expect(
  true,
  "node's evidence file vanishing is rejected, not silently excused",
  (d) => {
    rmSync(join(d, NODE_OBS));
  }
);

expect(
  true,
  "rungs.json declaring ZERO runtimes is rejected (totality over nothing)",
  (d) => {
    const f = join(d, "rungs.json");
    const m = JSON.parse(readFileSync(f, "utf8"));
    for (const rung of m.rungs) rung.runtimes = {};
    writeFileSync(f, JSON.stringify(m, null, 2));
  }
);

/*
 * THE ACCEPT CASE THAT KEEPS THE GUARD HONEST. Excluding `_`-prefixed modules is a real hole in
 * the module scan; it is defensible only because it tracks Python's own convention rather than a
 * name someone wanted quiet. If this case ever needs the exclusion widened to a non-underscore
 * file, that is the guard being muted, and it should be argued rather than patched.
 */
expect(
  false,
  "private and dunder modules do not count as unnamed subjects",
  (d) => {
    writeFileSync(join(d, RT[0], "__init__.py"), "");
    writeFileSync(
      join(d, RT[0], "_helpers.py"),
      "def helper():\n    return 1\n"
    );
  },
  { mutates: true }
);

/*
 * REFUSAL, NOT A VERDICT. The other cases ask what the guard says; this one asks whether it
 * declines to say anything when it cannot read its population. A `false` here would be the house
 * defect in miniature: a verdict it never computed.
 */
total++;
{
  const d = fixture();
  try {
    rmSync(join(d, "rungs.json"));
    let threw = false;
    try {
      checkSubjectTotality(d);
    } catch {
      threw = true;
    }
    if (threw) {
      pass++;
      console.log(
        `  ok   ${"an unreadable rungs.json REFUSES, does not pass".padEnd(
          52
        )} (refused)`
      );
    } else
      console.log(
        `  FAIL ${"an unreadable rungs.json REFUSES, does not pass".padEnd(
          52
        )} (returned a verdict it could not compute)`
      );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

expect(true, "DRIFTED _common.py is rejected", (d) => {
  const f = join(d, RT[1], "_common.py");
  const src = readFileSync(f, "utf8");
  writeFileSync(
    f,
    src.replace(
      "def langfuse_configured()",
      "def langfuse_configured_DRIFTED()"
    )
  );
});

expect(
  true,
  "anchor missing in BOTH is rejected (would compare two empty spans)",
  (d) => {
    for (const rt of RT) {
      const f = join(d, rt, "_common.py");
      writeFileSync(
        f,
        readFileSync(f, "utf8").replace("def make_llm", "def make_llm_RENAMED")
      );
    }
  }
);

expect(true, "a differing langfuse pin is rejected", (d) => {
  const f = join(d, REQ[1]);
  writeFileSync(
    f,
    readFileSync(f, "utf8").replace(/^langfuse.*$/m, "langfuse>=2,<3")
  );
});

expect(
  true,
  "langfuse absent from BOTH requirements is rejected (not 'they match')",
  (d) => {
    for (const r of REQ) {
      const f = join(d, r);
      writeFileSync(f, readFileSync(f, "utf8").replace(/^langfuse.*$/m, ""));
    }
  }
);

expect(true, "a re-committed 64-hex key in the fixture is rejected", (d) => {
  const f = join(d, FIX[0]);
  writeFileSync(
    f,
    readFileSync(f, "utf8").replace(
      /\$\{ENCRYPTION_KEY[^}]*\}/,
      "bdd9df36aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff2233445566"
    )
  );
});

expect(
  false,
  "the LOW-entropy labelled fixture values are NOT flagged",
  () => {},
  { mutates: false }
);
/**
 * THE TWO CASES BELOW ARE THE REASON `maskPythonNonCode` EXISTS, and they run in
 * opposite directions on purpose.
 *
 * The bug that prompted them: `langchain.py` gained a comment containing the
 * words `planner.ainvoke(...)`, explaining why the planner is invoked rather
 * than streamed. The checker matched the SENTENCE, counted a third invocation
 * site, and reported it as untraced — a comment saying a path is traced was read
 * as proof that it is not.
 *
 * The first case pins that. The second pins the direction that actually loses
 * tracing: prose cannot make an unwired site look WIRED either. Only the first
 * one was observed in the wild, and a fix asserted in one direction is exactly
 * how the opposite hole survives.
 */
expect(false, "a commented-out invocation is not a site", (d) => {
  const f = join(d, RT[0], "langchain.py");
  const src = readFileSync(f, "utf8");
  writeFileSync(
    f,
    src.replace(
      "async def _stream_agent_events(graph, agent_input):",
      "# see planner.ainvoke( and graph.astream_events( — prose, not code\n" +
        "async def _stream_agent_events(graph, agent_input):"
    )
  );
});

expect(true, "a comment cannot launder an UNWIRED site", (d) => {
  const f = join(d, RT[0], "langchain.py");
  const src = readFileSync(f, "utf8");
  writeFileSync(
    f,
    src.replace(
      'planner.ainvoke({"input": user_text}, config=langfuse_config())',
      'planner.ainvoke(\n        {"input": user_text}  # config=langfuse_config() is NOT passed here\n    )'
    )
  );
});

/*
 * ── THE PROMPTS ─────────────────────────────────────────────────────────────
 *
 * These constants sit ABOVE `def make_llm(`, so every case below is invisible
 * to `checkLockstep` — which is the point: each one is a tree that the previous
 * revision of this checker accepted while the two agents behaved differently.
 * The first case is the one that actually happened.
 */

expect(true, "a SYSTEM_PROMPT applied to one backend only", (d) => {
  const f = join(d, RT[0], "_common.py");
  writeFileSync(
    f,
    readFileSync(f, "utf8").replace(
      "When no available tool matches the request,",
      "When no available tool matches the request, answer it directly."
    )
  );
});

expect(true, "a RESEARCH_PROMPT applied to one backend only", (d) => {
  const f = join(d, RT[1], "_common.py");
  writeFileSync(
    f,
    readFileSync(f, "utf8").replace(
      "cite the URLs you used.",
      "cite the URLs you used. Never pass a URL to read_file."
    )
  );
});

expect(
  true,
  "a DELETED prompt is rejected (absent in one is not agreement)",
  (d) => {
    const f = join(d, RT[1], "_common.py");
    const src = readFileSync(f, "utf8");
    writeFileSync(f, src.replace(/^SYSTEM_PROMPT = """[\s\S]*?"""\n/m, ""));
  }
);

expect(true, "a RENAMED prompt is rejected (the pin is the record)", (d) => {
  for (const rt of RT) {
    const f = join(d, rt, "_common.py");
    writeFileSync(
      f,
      readFileSync(f, "utf8").replace(
        /^SYSTEM_PROMPT = /m,
        "ASSISTANT_PROMPT = "
      )
    );
  }
});

/*
 * THE BLIND SPOT ITSELF. A third prompt added to BOTH backends, identically, is
 * a tree in which nothing disagrees today — and which nothing would ever
 * compare. It is rejected until PROMPTS names it, because the failure this
 * whole section exists for was not "two files differ", it was "nobody knew
 * these two lines had to be kept the same".
 */
expect(true, "an UNREGISTERED prompt is rejected even when both agree", (d) => {
  for (const rt of RT) {
    const f = join(d, rt, "_common.py");
    writeFileSync(
      f,
      readFileSync(f, "utf8").replace(
        /^SYSTEM_PROMPT = /m,
        'TRIAGE_PROMPT = """\\\nYou are a triage agent.\n"""\n\n\nSYSTEM_PROMPT = '
      )
    );
  }
});

/*
 * THE REPAIR THAT LOOKS OBVIOUS AND CANNOT WORK.
 *
 * check-langfuse-wiring.mjs documents why the prompts get their own comparison
 * instead of a lower ANCHOR, and a reason stated only in prose is the defect
 * class this repo keeps finding. So it is measured: `codeOnly` — the normaliser
 * `checkLockstep` compares through — collapses two DIFFERENT prompts to the
 * same text. Anyone who "simplifies" this by moving the anchor will fail here
 * rather than ship a check that passes on every input.
 */
total++;
{
  const a = 'SYSTEM_PROMPT = """\nYou are concise.\n"""\n';
  const b =
    'SYSTEM_PROMPT = """\nYou are verbose, and you must never stop.\n"""\n';
  if (a !== b && codeOnly(a) === codeOnly(b)) {
    pass++;
    console.log(
      `  ok   ${"a HIGHER anchor would be vacuous (proved)".padEnd(
        52
      )} (codeOnly erases both prompts)`
    );
  } else {
    console.log(
      `  FAIL ${"a HIGHER anchor would be vacuous (proved)".padEnd(52)} ` +
        `(codeOnly no longer erases prompt literals — the separate comparison's ` +
        `justification has changed and must be re-derived)`
    );
  }
}

console.log();
if (voided > 0) {
  console.log(
    `FAIL: ${voided} mutation(s) changed nothing — those proofs are VOID.`
  );
  console.log(
    `      Re-anchor them. A checker is not implicated by a mutation that never happened.`
  );
  process.exit(1);
}
if (pass === total) {
  console.log(
    `PASS: ${pass}/${total}. check-langfuse-wiring.mjs has been observed to fail on`
  );
  console.log(
    `      unwired, deleted, missing, drifted and subject-less input — including the`
  );
  console.log(
    `      two cases where BOTH sides are absent and "they match" would be vacuous,`
  );
  console.log(
    `      the four where a plane or module exists that the literals never named, and`
  );
  console.log(
    `      the one where it REFUSES rather than answer from a population it cannot read.`
  );
  console.log(
    `      It has also been observed to fail on a prompt applied to ONE backend, a prompt`
  );
  console.log(
    `      deleted from one, a prompt renamed in both, and a NEW prompt added identically`
  );
  console.log(
    `      to both without being pinned — the last being the shape of the original defect,`
  );
  console.log(
    `      which was not two files disagreeing but nobody knowing they had to agree.`
  );
  process.exit(0);
}
console.log(`FAIL: ${pass}/${total}`);
process.exit(1);

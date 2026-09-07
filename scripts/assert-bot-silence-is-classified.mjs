/**
 * A BOT THAT PRODUCED NOTHING IS SATURATED OR STALLED, AND SILENCE DOES NOT SAY WHICH (#810).
 *
 * Dependabot opens no PR for two opposite reasons: it is AT its open-PR limit and cannot, or it
 * is under the limit and produced nothing. The output is identical — no new PR — and only one
 * of them is healthy. THE DISCRIMINATOR IS CAPACITY, and it needs no run log, which is the thing
 * GitHub does not expose. (`dependabot/alerts` is a different feature and answers nothing here.)
 *
 *     open == limit   silence is EXPLAINED: the channel is full, no new update can open,
 *                     security updates included
 *     open <  limit   silence is UNEXPLAINED: capacity exists and nothing used it
 *
 * SAME SHAPE AS EVERY OTHER ABSENCE THIS REPO HAS CHASED. A checker examining zero pointers
 * passes; a proof running six cases that print nothing reports success; a bot opening zero PRs
 * looks healthy. In each, ABSENCE OF OUTPUT IS READ AS ABSENCE OF WORK TO DO, and the repair is
 * never to look harder at the output — it is to compare it against the capacity, the one number
 * that differs between the two worlds.
 *
 * WHAT THIS DOES NOT CLAIM. It does not detect silence: it cannot see when the bot last ran, and
 * neither can anything else without a log GitHub withholds. It reports the CAPACITY STATE so a
 * human who observes silence can classify it, and it fails only when that classification would
 * be impossible.
 *
 * THE SEVENTEEN-DAY GAP WAS NOT SATURATION, and this check would have said so. A bot at its
 * limit has ten open; this one had ZERO, because it had never opened one — the gap is between
 * the config landing and the feature being switched on. Under-limit-and-silent, which is the
 * arm that alerts.
 *
 * Exit 0 every ecosystem classified · 1 a classification is impossible · 2 an input unreadable.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { invokedAsProgram } from "./lib/is-main.mjs";
import { reportSubject } from "./lib/subject.mjs";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

/*
 * DEPENDABOT'S BRANCH SLUG PER ECOSYSTEM, which is a CONVENTION and not derivable from the
 * config. `package-ecosystem: npm` produces `dependabot/npm_and_yarn/…`. Labels would have been
 * derivable — the config declares them — but MEASURED: all thirteen open PRs carry none, so the
 * declared labels are not applied and a label-keyed count would report zero for everything.
 *
 * AN ECOSYSTEM MISSING FROM THIS MAP IS A FAILURE, NOT A ZERO. Counting branches for a slug
 * nobody knows returns 0 open, which is indistinguishable from a bot with nothing to do — this
 * checker's own subject, one level down. So an unmapped ecosystem is reported rather than
 * silently counted as empty.
 */
export const SLUGS = {
  npm: "npm_and_yarn",
  "github-actions": "github_actions",
  pip: "pip",
  docker: "docker",
  gomod: "go_modules",
  cargo: "cargo",
  bundler: "bundler",
  composer: "composer",
  nuget: "nuget",
  maven: "maven",
  gradle: "gradle",
  terraform: "terraform",
};

/**
 * Ecosystems and their open-PR limits, read line-wise because this repo has no YAML parser.
 *
 * The DEFAULT is 5 when `open-pull-requests-limit` is absent — Dependabot's own default — and an
 * ecosystem taking it is reported as taking it, so a reader is not left inferring whether 5 was
 * chosen or inherited.
 */
export function ecosystems(yaml) {
  const out = [];
  let cur = null;
  for (const raw of String(yaml ?? "").split("\n")) {
    const line = raw.replace(/#.*$/, "");
    const eco = line.match(
      /^\s*-\s*package-ecosystem:\s*["']?([\w-]+)["']?\s*$/
    );
    if (eco) {
      cur = { name: eco[1], limit: null, declared: false };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const lim = line.match(/^\s*open-pull-requests-limit:\s*(\d+)\s*$/);
    if (lim) {
      cur.limit = Number(lim[1]);
      cur.declared = true;
    }
  }
  for (const e of out) if (e.limit === null) e.limit = 5;
  return out;
}

/** Open Dependabot PRs grouped by the ecosystem slug in their branch name. */
export function countBySlug(prs) {
  const byslug = new Map();
  const unmatched = [];
  for (const p of prs ?? []) {
    if (!/dependabot/i.test(p?.author?.login ?? "")) continue;
    const m = String(p.headRefName ?? "").match(/^dependabot\/([^/]+)\//);
    if (!m) {
      unmatched.push(p.headRefName ?? "(no branch)");
      continue;
    }
    byslug.set(m[1], (byslug.get(m[1]) ?? 0) + 1);
  }
  return { byslug, unmatched };
}

function refuse(what, err) {
  console.error(
    `\nCOULD NOT CHECK: ${what}\n\n  ${String(err?.message ?? err)}\n\n` +
      `  Exiting 2: the question could not be asked. A missing limit or an unread board means\n` +
      `  the comparison cannot be made — NOT that the bot is fine. Reporting "0 open" from an\n` +
      `  input that failed is the exact confusion this check exists to end.\n`
  );
  process.exit(2);
}

function main() {
  let yaml;
  try {
    yaml = readFileSync(join(ROOT, ".github/dependabot.yml"), "utf8");
  } catch (err) {
    refuse(
      ".github/dependabot.yml could not be read, so no limit is known.",
      err
    );
  }
  const ecos = ecosystems(yaml);
  if (ecos.length === 0)
    refuse(
      ".github/dependabot.yml declares no `package-ecosystem`, so there is nothing whose " +
        "silence could be classified.",
      "no ecosystems parsed"
    );

  /*
   * THE SPAWN AND THE PARSE ARE SEPARATE (#851). Both exit 2, and they send a reader to
   * different places: a failed `gh` means the board could not be reached, while `gh` exiting 0
   * and printing something unparseable means it ANSWERED and the answer could not be read. One
   * message for both is what #851 found shipped in assert-build-order.
   */
  let raw;
  try {
    raw = execFileSync(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        "200",
        "--json",
        "author,headRefName",
      ],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 }
    );
  } catch (err) {
    /*
     * TWO SPAWN-SIDE FAILURES, NOT ONE — #851's conflation one level finer. `execFileSync`
     * throws BOTH when the binary is absent and when it RAN AND EXITED NON-ZERO, and an earlier
     * version of this message asserted the first for both. Watched being wrong: during a GraphQL
     * rate limit `gh` exits 1 with "API rate limit already exceeded", and this told the reader
     * `gh` had not run — sending someone to check their installation while the real cause was a
     * throttle, in exactly the conditions this checker exists for.
     */
    if (err?.code === "ENOENT")
      refuse(
        "`gh` is not installed or is not on PATH, so the open pull requests could not be listed.",
        err
      );
    refuse(
      "`gh` RAN and exited non-zero, so the open pull requests could not be listed. This is NOT " +
        "a missing binary — read what it printed above; a throttled board looks like this.",
      err
    );
  }
  let prs;
  try {
    prs = JSON.parse(raw);
  } catch (err) {
    refuse(
      "`gh` ran and printed something that is not JSON, so the open PRs could not be read. " +
        `It printed: ${String(raw).slice(0, 200) || "(nothing)"}`,
      err
    );
  }

  const { byslug, unmatched } = countBySlug(prs);
  const problems = [];
  const rows = [];
  for (const e of ecos) {
    const slug = SLUGS[e.name];
    if (!slug) {
      problems.push(
        `\`${e.name}\` has no known branch slug, so its open count cannot be measured. It would ` +
          `read 0 — indistinguishable from a bot with nothing to do, which is this check's own ` +
          `subject. Add it to SLUGS in ${"scripts/assert-bot-silence-is-classified.mjs"}.`
      );
      continue;
    }
    const open = byslug.get(slug) ?? 0;
    byslug.delete(slug);
    rows.push({ ...e, slug, open, saturated: open >= e.limit });
  }
  for (const [slug, n] of byslug)
    problems.push(
      `${n} open PR(s) on \`dependabot/${slug}/…\` belong to no ecosystem in dependabot.yml — ` +
        `the config and the board disagree about what this bot is updating.`
    );
  for (const b of unmatched)
    problems.push(
      `a Dependabot PR on \`${b}\` has no \`dependabot/<slug>/\` branch prefix.`
    );

  if (problems.length > 0) {
    console.error(
      `FAIL: ${problems.length} ecosystem(s) whose silence cannot be classified:`
    );
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      `\n      An ecosystem that cannot be counted is worse than one at its limit: the count\n` +
        `      reads 0, which is the same output a healthy idle bot produces.`
    );
    process.exit(1);
  }

  reportSubject(
    rows.length,
    "dependabot ecosystem(s) whose capacity was compared"
  );
  for (const r of rows)
    console.log(
      `  ${r.name}: ${r.open} open of ${r.limit}${
        r.declared ? "" : " (Dependabot's default, not declared)"
      } — ` +
        (r.saturated
          ? "SATURATED. Silence here is EXPLAINED: no new update can open, security included, " +
            "until one closes."
          : "under limit. Silence here is UNEXPLAINED — capacity exists and nothing used it.")
    );
  console.log(
    `\nPASS: every configured ecosystem has a limit and a measurable open count, so silence is\n` +
      `      classifiable. This does NOT assert the bot ran — nothing can, without a log GitHub\n` +
      `      does not expose. It asserts that WHEN silence is observed, it can be explained.`
  );
}

if (invokedAsProgram(import.meta.url)) main();

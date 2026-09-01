#!/usr/bin/env node
/**
 * assert-fork-python-imports-resolve.mjs — every local Python import in this tree resolves to a
 * file this tree still has.
 *
 * THE DEFECT, MEASURED (#565). A fork below rung 3 could not collect its Python tests:
 *
 *     ERROR collecting tests/test_turn_usage.py
 *     ImportError: cannot import name 'deepagents' from 'ai_backends'
 *
 * `apps/fastapi-backend/tests/test_turn_usage.py` is SHARED, so it survives every eject;
 * `ai_backends/deepagents.py` is rung-owned and is correctly deleted. The test outlived its
 * subject.
 *
 * AND NO GATE COULD SEE IT. The py eject legs run `pnpm payloads`, `ruff check --select F821`,
 * a health-probe selftest and a boot check. F821 is undefined NAMES, not unresolvable imports.
 * severability.yml's own comment already records that the boot check is not a substitute,
 * because it executes only the import graph reachable at boot — and a test module is not.
 * So the failure was real, reproducible, and invisible to every gate in the repo.
 *
 * IT IS A POPULATION, NOT AN INSTANCE, WHICH IS WHY THIS EXISTS AT ALL. Ejecting to the lowest
 * rung and differencing the unresolvable-import set before and against after:
 *
 *     3 shared test files, 6 imports  (#565 reported one of the three)
 *
 * The differential is the measurement rather than the raw count, because a static resolver has
 * blind spots in both trees and only the DIFFERENCE is attributable to the eject.
 *
 * WHY NOT `pytest --collect-only`, which would be ground truth: it needs the backend's
 * third-party requirements installed in every eject leg, and the failure being caught is an
 * ImportError over LOCAL modules — the part that needs no dependencies to decide. This resolves
 * exactly that and nothing else: an import is checked only when its target is a path inside the
 * app, so a missing `fastapi` is not this check's business and never reported as one.
 *
 * Exit codes:  0 = every local import resolves   1 = one does not   2 = could not be checked
 *
 * Usage: node scripts/assert-fork-python-imports-resolve.mjs [--cwd DIR]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, resolve as resolvePath } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

/** Tracked files, so an untracked scratch .py never fails a fork. */
function trackedFiles(cwd) {
  return execFileSync("git", ["-C", cwd, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  })
    .split("\0")
    .filter(Boolean);
}

/** `apps/fastapi-backend/tests/x.py` -> `apps/fastapi-backend`, the sys.path root pytest uses. */
export function appRootOf(file) {
  return file.split("/").slice(0, 2).join("/");
}

/**
 * Resolve a dotted module under `base` to a tracked file, mirroring Python's own order: a
 * module file first, then a package's `__init__.py`.
 */
export function moduleFile(tracked, base, dotted) {
  const rel = dotted ? dotted.split(".").join("/") : "";
  const cands = [];
  if (rel) cands.push(normalize(join(base, `${rel}.py`)));
  cands.push(normalize(join(base, rel, "__init__.py")));
  return cands.find((c) => tracked.has(c)) ?? null;
}

/** Does `name` appear as a binding in this module's source? Cheap, and only used to spare. */
export function bindsName(src, name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    // `async def` is a real binding and the first version of this missed it, which showed up
    // as two false positives on a clean tree — see the selftest case that pins it.
    `^\\s*(?:async\\s+)?(?:def|class)\\s+${n}\\b|^\\s*${n}\\s*[:=]|\\bimport\\s+[^\\n]*\\b${n}\\b`,
    "m"
  ).test(src);
}

export function unresolved(cwd) {
  const files = trackedFiles(cwd);
  const tracked = new Set(files);
  const py = files.filter((f) => f.endsWith(".py"));
  const problems = [];
  let examined = 0;

  for (const f of py) {
    let src;
    try {
      src = readFileSync(join(cwd, f), "utf8");
    } catch {
      /*
       * A TRACKED FILE THAT CANNOT BE READ IS NOT A FILE WITH NO PROBLEMS (#549). Counting it
       * as examined would let a whole unreadable tree pass as clean, which is the shape that
       * gate exists to refuse.
       */
      problems.push({ file: f, stmt: "(could not be read)", why: "unreadable" });
      continue;
    }
    examined++;
    const appRoot = appRootOf(f);
    const ownDir = dirname(f);

    for (const m of src.matchAll(
      /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+([^\n(#]+)/gm
    )) {
      const dots = m[1].length;
      const pkg = m[2];
      let base = appRoot;
      if (dots) {
        base = ownDir;
        for (let i = 1; i < dots; i++) base = dirname(base);
      }
      const pkgDir = normalize(join(base, pkg ? pkg.split(".").join("/") : ""));
      const pkgFile = moduleFile(tracked, base, pkg);
      const isLocal =
        pkgFile !== null || files.some((t) => t.startsWith(`${pkgDir}/`));
      if (!isLocal) continue; // stdlib or an installed dependency — not this check's subject

      const pkgSrc = pkgFile ? readFileSync(join(cwd, pkgFile), "utf8") : "";
      for (const raw of m[3].split(",")) {
        const name = raw.trim().split(/\s+as\s+/)[0].trim();
        if (!name || name === "*") continue;
        if (moduleFile(tracked, pkgDir, name)) continue; // a submodule file
        if (pkgSrc && bindsName(pkgSrc, name)) continue; // a symbol the package binds
        if (!pkgFile) {
          problems.push({
            file: f,
            stmt: `from ${".".repeat(dots)}${pkg} import ${name}`,
            why: `no ${pkgDir}/__init__.py and no ${pkgDir}/${name}.py`,
          });
        } else {
          problems.push({
            file: f,
            stmt: `from ${".".repeat(dots)}${pkg} import ${name}`,
            why: `${pkgDir}/${name}.py is absent and ${pkgFile} does not bind "${name}"`,
          });
        }
      }
    }

    for (const m of src.matchAll(/^[ \t]*import[ \t]+([\w.]+)/gm)) {
      const dotted = m[1];
      const head = dotted.split(".")[0];
      const headIsLocal =
        moduleFile(tracked, appRoot, head) !== null ||
        files.some((t) => t.startsWith(`${appRoot}/${head}/`));
      if (!headIsLocal) continue;
      if (!moduleFile(tracked, appRoot, dotted)) {
        problems.push({
          file: f,
          stmt: `import ${dotted}`,
          why: `${appRoot}/${dotted.split(".").join("/")}.py is absent`,
        });
      }
    }
  }
  return { examined, total: py.length, problems };
}

function main() {
  const cwd = resolvePath(argOf("--cwd", ROOT));
  if (!existsSync(join(cwd, ".git")) && !existsSync(join(cwd, "rungs.json"))) {
    console.error(`REFUSE: ${cwd} is not a checkout of this repo.`);
    process.exit(2);
  }
  const r = unresolved(cwd);

  /*
   * NOTHING EXAMINED IS NOT NOTHING WRONG (#549). A tree with no Python at all is a legitimate
   * fork; a tree WITH Python where none of it could be read is a check that lost its subject.
   */
  if (r.total > 0 && r.examined === 0) {
    console.error(
      `REFUSE: ${r.total} Python file(s) are tracked here and NONE could be read, so this ` +
        `examined nothing.`
    );
    process.exit(2);
  }
  if (r.total === 0) {
    console.log("PASS: this tree has no tracked Python files — nothing to resolve.");
    return;
  }

  if (r.problems.length === 0) {
    console.log(
      `PASS: every local Python import resolves — ${r.examined} file(s) examined across the ` +
        `tracked tree.`
    );
    return;
  }

  console.error(
    `FAIL: ${r.problems.length} local Python import(s) do not resolve in this tree.\n` +
      `      A SHARED file that imports a RUNG-OWNED module outlives its subject: the file\n` +
      `      survives the eject, the module it needs does not, and pytest cannot even COLLECT\n` +
      `      it. \`ruff --select F821\` does not see this, and neither does the boot check,\n` +
      `      which executes only the import graph reachable at boot.\n`
  );
  for (const p of r.problems.slice(0, 40)) {
    console.error(`  ${p.file}`);
    console.error(`      ${p.stmt}`);
    console.error(`      ${p.why}`);
  }
  if (r.problems.length > 40) console.error(`  …and ${r.problems.length - 40} more`);
  console.error(
    `\n  Either give the file to the rung it depends on (\`owns\` in rungs.json), so it leaves\n` +
      `  with its subject, or make the import conditional and let the test SKIP — visibly,\n` +
      `  with a declared reason, because a skip is not a pass.\n` +
      `      ${r.examined} file(s) examined.`
  );
  process.exit(1);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();

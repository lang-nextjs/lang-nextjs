#!/usr/bin/env node
"use strict";
/**
 * Proves the license gate can FAIL, not just that it can pass.
 *
 * A per-package allowlist is very easy to write as "matches nothing and
 * therefore passes". The decisive case is REJECT_OTHER_UNLICENSED below: it
 * plants a DIFFERENT unlicensed production dependency and requires the gate
 * to still fail. If that case ever goes green, the exception has degenerated
 * into a blanket `UNLICENSED` allowlist wearing a per-package disguise.
 *
 * Runs in CI immediately BEFORE the real audit. A checker never observed to
 * fail is indistinguishable from one that cannot.
 */
const assert = require("assert");
const { audit } = require("./license-audit.js");

const THEME = { name: "@digitalfrontier/theme", versions: ["1.0.0"] };
const PERMISSIVE_BASE = {
  MIT: [{ name: "react", versions: ["19.2.6"] }],
  "Apache-2.0": [{ name: "some-apache-pkg", versions: ["1.0.0"] }],
  "(Apache-2.0 AND MIT)": [{ name: "dual-pkg", versions: ["1.0.0"] }],
  "LGPL-3.0-or-later": [
    { name: "@img/sharp-libvips-linux-x64", versions: ["1.2.4"] },
  ],
};

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

console.log("license-audit selftest:");

check("ACCEPT: permissive tree with the theme exception in place", () => {
  const r = audit({ ...PERMISSIVE_BASE, UNLICENSED: [THEME] });
  assert.strictEqual(
    r.ok,
    true,
    `expected pass, got bad=${JSON.stringify(r.bad)}`
  );
  assert.strictEqual(r.applied.length, 1);
  assert.strictEqual(r.applied[0].name, "@digitalfrontier/theme");
});

// THE ONE THAT MATTERS.
check(
  "REJECT: a DIFFERENT unlicensed dep still fails (not a blanket allowlist)",
  () => {
    const r = audit({
      ...PERMISSIVE_BASE,
      UNLICENSED: [
        THEME,
        { name: "sneaky-unlicensed-pkg", versions: ["0.1.0"] },
      ],
    });
    assert.strictEqual(
      r.ok,
      false,
      "gate passed a second UNLICENSED package — exception is a blanket allowlist"
    );
    assert.deepStrictEqual(
      r.bad.map((b) => b.name),
      ["sneaky-unlicensed-pkg"]
    );
  }
);

check("REJECT: removing the exception makes the theme fail again", () => {
  const r = audit({ ...PERMISSIVE_BASE, UNLICENSED: [THEME] }, {});
  assert.strictEqual(
    r.ok,
    false,
    "theme passed with NO exception — something else is doing the work"
  );
  assert.deepStrictEqual(
    r.bad.map((b) => b.name),
    ["@digitalfrontier/theme"]
  );
});

check(
  "REJECT: the exception is license-bound, not a blanket pass for the package",
  () => {
    const r = audit({ ...PERMISSIVE_BASE, "GPL-3.0-only": [THEME] });
    assert.strictEqual(
      r.ok,
      false,
      "theme exception leaked to a different license"
    );
    assert.deepStrictEqual(
      r.bad.map((b) => b.license),
      ["GPL-3.0-only"]
    );
  }
);

check("REJECT: an ordinary copyleft dep fails", () => {
  const r = audit({
    ...PERMISSIVE_BASE,
    "GPL-3.0-only": [{ name: "gpl-pkg", versions: ["2.0.0"] }],
  });
  assert.strictEqual(r.ok, false);
});

check(
  "REJECT: an SPDX expression with one non-permissive component fails",
  () => {
    const r = audit({
      ...PERMISSIVE_BASE,
      "(MIT OR GPL-3.0-only)": [{ name: "mixed", versions: ["1.0.0"] }],
    });
    assert.strictEqual(
      r.ok,
      false,
      "SPDX splitter allowed a non-permissive component"
    );
  }
);

check("ACCEPT: a wholly permissive tree with no exceptions needed", () => {
  const r = audit(PERMISSIVE_BASE);
  assert.strictEqual(
    r.ok,
    true,
    `expected pass, got bad=${JSON.stringify(r.bad)}`
  );
  assert.strictEqual(r.applied.length, 0);
});

if (failures) {
  console.log(`\n${failures} selftest case(s) failed.`);
  process.exit(1);
}
console.log(
  "\nAll selftest cases passed — the gate accepts and rejects as specified."
);

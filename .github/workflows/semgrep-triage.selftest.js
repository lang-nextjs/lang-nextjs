#!/usr/bin/env node
'use strict';
/**
 * Proves the semgrep triage gate can FAIL, not just pass.
 *
 * A (rule × path) exception is easy to write as a blanket exclusion in disguise.
 * The two decisive cases are PATH-BOUND and RULE-BOUND below. Both were also
 * verified against REAL semgrep runs on the vendored tree by planting findings:
 *   - detect-child-process in a different file      -> blocked
 *   - detect-child-process inside crypto.ts, which  -> blocked
 *     is excepted only for gcm-no-tag-length
 *
 * Runs in CI before the real triage. A checker never observed to fail is
 * indistinguishable from one that cannot.
 */
const assert = require('assert');
const { triage, EXCEPTIONS } = require('./semgrep-triage.js');

const R_GCM = 'javascript.node-crypto.security.gcm-no-tag-length.gcm-no-tag-length';
const R_CP  = 'javascript.lang.security.detect-child-process.detect-child-process';
const P_CRYPTO = 'rungs/5-software-developer-agent/packages/shared/src/crypto.ts';
const P_SHELL  = 'rungs/5-software-developer-agent/apps/open-swe/src/utils/shell-executor/local-shell-executor.ts';

let failures = 0;
const check = (n, fn) => {
  try { fn(); console.log(`  PASS  ${n}`); }
  catch (e) { failures++; console.log(`  FAIL  ${n}\n        ${e.message}`); }
};

console.log('semgrep-triage selftest:');

check('ACCEPT: the three known vendored findings pass', () => {
  const r = triage([
    { check_id: R_GCM, path: P_CRYPTO, line: 115 },
    { check_id: R_CP, path: P_SHELL, line: 81 },
    { check_id: 'package_managers.yarn.yarn-missing-minimal-age-gate.yarn-missing-minimal-age-gate',
      path: 'rungs/5-software-developer-agent/.yarnrc.yml', line: 1 },
  ]);
  assert.strictEqual(r.ok, true, `expected pass, blocking=${JSON.stringify(r.blocking)}`);
  assert.strictEqual(r.suppressed.length, 3);
});

// PATH-BOUND — an excepted rule firing somewhere else must still block.
check('REJECT: excepted rule at a DIFFERENT path still blocks', () => {
  const r = triage([{ check_id: R_CP, path: 'rungs/5-software-developer-agent/apps/open-swe/src/other.ts', line: 3 }]);
  assert.strictEqual(r.ok, false, 'exception is path-blind — it is a blanket rule exclusion');
});

// RULE-BOUND — a different rule in an excepted file must still block.
check('REJECT: a DIFFERENT rule in an excepted file still blocks', () => {
  const r = triage([{ check_id: R_CP, path: P_CRYPTO, line: 136 }]);
  assert.strictEqual(r.ok, false, 'exception is rule-blind — it is a blanket file exclusion');
});

check('REJECT: anything else anywhere in the vendored tree blocks', () => {
  const r = triage([{ check_id: 'javascript.lang.security.audit.sqli', path: 'rungs/5-software-developer-agent/x.ts', line: 1 }]);
  assert.strictEqual(r.ok, false, 'vendored tree is blanket-excluded');
});

check('REJECT: removing the exceptions makes all three block again', () => {
  const r = triage([
    { check_id: R_GCM, path: P_CRYPTO, line: 115 },
    { check_id: R_CP, path: P_SHELL, line: 81 },
  ], []);
  assert.strictEqual(r.ok, false, 'something other than the exceptions is doing the work');
  assert.strictEqual(r.blocking.length, 2);
});

check('ACCEPT: a clean scan passes', () => {
  assert.strictEqual(triage([]).ok, true);
});

check('every exception carries a verdict and a reason', () => {
  for (const e of EXCEPTIONS) {
    assert.ok(e.verdict && e.verdict.length > 20, `${e.rule}: no verdict`);
    assert.ok(e.reason && e.reason.length > 80, `${e.rule}: reason too thin to be an assessment`);
  }
});

if (failures) { console.log(`\n${failures} selftest case(s) failed.`); process.exit(1); }
console.log('\nAll selftest cases passed — the gate is rule-bound AND path-bound.');

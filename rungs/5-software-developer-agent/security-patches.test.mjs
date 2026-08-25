/**
 * lang-nextjs SECURITY PATCH TESTS — not upstream.
 *
 * Covers the two patches applied to this vendored tree. See PROVENANCE.md for the
 * patch manifest and ../../docs/rungs/5-software-developer-agent.md for the notice.
 *
 *   #84 — apps/open-swe/src/routes/github/unified-webhook.ts
 *         upstream read the signature and the secret and never compared them
 *   #82 — packages/shared/src/crypto.ts
 *         upstream derived the AES key with a single-pass SHA-256
 *
 * WHY THIS FILE IS PLAIN node:test AND NOT OUR VITEST SUITE:
 * this tree is a yarn 3 workspace with its own dependency graph (hono,
 * @octokit/webhooks). The repo's vitest packages cannot import from here — and
 * must not: packages/server is SHARED, so importing rung-5 code into it would be a
 * severability violation, which is the defect this milestone exists to prevent.
 *
 * Run:  cd rungs/5-software-developer-agent && node --test security-patches.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";

const SECRET = "the-real-webhook-secret-value";

// This module's import graph reads GitHub App config at MODULE LOAD time and
// throws without it, so the env must be populated before the dynamic import
// below. The key is generated here, per run, and never leaves the process — do
// not replace it with a fixture file.
process.env.GITHUB_APP_ID = "12345";
process.env.GITHUB_APP_NAME = "open-swe-dev";
process.env.GITHUB_WEBHOOK_SECRET = SECRET;
process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const WRONG_SECRET = "not-the-webhook-secret-value";

/** GitHub's scheme: sha256=<hex hmac of the RAW body>. */
function sign(body, secret) {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

/* ========================================================================== */
/*  #84 — webhook signature verification                                      */
/* ========================================================================== */

/**
 * Loads the handler with a stubbed dispatch so we can observe whether the
 * REQUEST EVER REACHED IT. Asserting only on the 403 is not enough: upstream's
 * code returns 403 for a missing signature too, so a status-only test passes
 * against the vulnerable version and tells you nothing.
 */
// Imported EAGERLY and WITHOUT a catch. An earlier version of this file wrapped
// both imports in `.catch(() => null)` and skipped when they failed — so the four
// #84 tests reported as "skipped" while the module was throwing at load, and the
// run showed 6 pass / 0 fail. A security test that cannot load must FAIL: a skip
// is indistinguishable from a pass in every summary line that matters.
const webhookMod = await import(
  "./apps/open-swe/dist/src/routes/github/unified-webhook.js"
);
async function loadWebhookHandler() {
  return webhookMod;
}

/** Minimal Hono-ish context: only what handleWebhook actually touches. */
function makeContext(body, headers) {
  const sent = {};
  return {
    ctx: {
      req: {
        header: (name) => headers[name.toLowerCase()],
        text: async () => body,
      },
      text: (payload, status) => {
        sent.payload = payload;
        sent.status = status;
        return { payload, status };
      },
      json: (payload, status) => {
        sent.payload = payload;
        sent.status = status;
        return { payload, status };
      },
    },
    sent,
  };
}

test("#84 REJECT: a signature computed with the WRONG secret is rejected", async () => {
  const mod = await loadWebhookHandler();

  const body = JSON.stringify({
    action: "labeled",
    issue: { number: 1, labels: [{ name: "open-swe" }] },
    repository: { full_name: "o/r" },
  });

  // A FORGED signature, not a random string. A random string is rejected by a
  // correct implementation AND by a broken one that merely checks the header is
  // well-formed — it cannot distinguish them. A signature that is structurally
  // valid but computed with the wrong key can only be rejected by real
  // verification.
  const forged = sign(body, WRONG_SECRET);

  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  const { ctx, sent } = makeContext(body, {
    "x-hub-signature-256": forged,
    "x-github-event": "issues",
    "x-github-delivery": "d1",
  });

  await mod.handleWebhook(ctx);
  assert.equal(sent.status, 403, "a forged signature must be refused");
});

test("#84 REJECT: the forged request never reaches the dispatcher", async () => {
  // THE ASSERTION THAT CATCHES THE UNPATCHED CODE. Upstream returned 403 for a
  // missing signature, so "did it 403" passes there too. What upstream could not
  // do is stop a forged-but-present signature from reaching processWebhookEvent.
  //
  // Observed indirectly: the dispatcher calls handleIssueLabeled, which needs a
  // GitHub installation token. If dispatch is reached with no credentials
  // configured it throws or logs; the handler swallows handler errors and returns
  // 200 ("Don't fail the webhook"). So a 200 here means dispatch was REACHED.
  // A 403 means it was refused before that point.
  const mod = await loadWebhookHandler();

  const body = JSON.stringify({
    action: "labeled",
    issue: { number: 1, labels: [{ name: "open-swe" }] },
    repository: { full_name: "o/r" },
  });
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  const { ctx, sent } = makeContext(body, {
    "x-hub-signature-256": sign(body, WRONG_SECRET),
    "x-github-event": "issues",
    "x-github-delivery": "d1",
  });

  await mod.handleWebhook(ctx);
  assert.notEqual(
    sent.status,
    200,
    "a 200 means the handler ran — dispatch was reached with a forged signature",
  );
  assert.equal(sent.status, 403);
});

test("#84 ACCEPT: a signature computed with the RIGHT secret passes verification", async () => {
  const mod = await loadWebhookHandler();

  const body = JSON.stringify({ action: "opened", zen: "ok" });
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  const { ctx, sent } = makeContext(body, {
    "x-hub-signature-256": sign(body, SECRET),
    // An event the dispatcher does not handle: it falls to the "Unhandled webhook
    // event" branch and returns 200 without needing GitHub credentials. That
    // isolates "verification passed" from "the handler happened to succeed".
    "x-github-event": "ping",
    "x-github-delivery": "d2",
  });

  await mod.handleWebhook(ctx);
  assert.equal(
    sent.status,
    200,
    "a correctly signed request must be accepted and dispatched",
  );
});

test("#84 REJECT: a body altered after signing is rejected", async () => {
  const mod = await loadWebhookHandler();

  const original = JSON.stringify({ action: "opened", repo: "safe" });
  const tampered = JSON.stringify({ action: "opened", repo: "attacker" });
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;

  // Signature is valid for `original`; we deliver `tampered`. This is the property
  // that verifying the RAW body buys — verifying a re-serialised parse would not
  // catch it.
  const { ctx, sent } = makeContext(tampered, {
    "x-hub-signature-256": sign(original, SECRET),
    "x-github-event": "ping",
    "x-github-delivery": "d3",
  });

  await mod.handleWebhook(ctx);
  assert.equal(sent.status, 403, "a tampered body must be refused");
});

/* ========================================================================== */
/*  #82 — key derivation                                                      */
/* ========================================================================== */

// Same rule as above: no catch, no skip.
const cryptoMod = await import("./packages/shared/dist/crypto.js");

const GOOD_KEY = "a".repeat(8) + "0123456789abcdef0123456789abcdef";

test("#82 ACCEPT: encrypt/decrypt round-trips with a strong key", () => {
  const secret = "ghp_exampletoken";
  const out = cryptoMod.decryptSecret(
    cryptoMod.encryptSecret(secret, GOOD_KEY),
    GOOD_KEY,
  );
  assert.equal(out, secret);
});

test("#82 ACCEPT: the same plaintext and key produce DIFFERENT ciphertext", () => {
  // Per-encryption salt AND per-encryption IV. Upstream's keyless-salt derivation
  // meant the key was identical every time; only the IV varied.
  const a = cryptoMod.encryptSecret("same", GOOD_KEY);
  const b = cryptoMod.encryptSecret("same", GOOD_KEY);
  assert.notEqual(a, b);
});

test("#82 REJECT: the derived key is NOT a bare SHA-256 of the input", async () => {
  // The defect, stated directly: if deriveKey regresses to upstream's fast hash,
  // every ciphertext becomes offline-guessable.
  //
  // Tries BOTH envelope layouts, and that is not belt-and-braces. An earlier
  // version read the IV at the SALTED offset only; run against upstream's
  // saltless envelope those offsets point at garbage, decryption threw, and
  // `assert.throws` was satisfied — so the test PASSED against the very code it
  // exists to reject. It was asserting my envelope's shape, not the derivation.
  // Trying the upstream layout too means a bare-SHA-256 key can actually succeed,
  // which is what makes the rejection meaningful.
  const { createHash, createDecipheriv } = await import("node:crypto");
  const sha = createHash("sha256").update(GOOD_KEY).digest();
  const combined = Buffer.from(
    cryptoMod.encryptSecret("probe", GOOD_KEY),
    "base64",
  );

  const attempt = (ivOffset) => {
    const iv = combined.subarray(ivOffset, ivOffset + 12);
    const tag = combined.subarray(combined.length - 16);
    const body = combined.subarray(ivOffset + 12, combined.length - 16);
    const d = createDecipheriv("aes-256-gcm", sha, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString("utf8");
  };

  // 0  = upstream's saltless layout (IV first)
  // 16 = this tree's patched layout (salt, then IV)
  for (const ivOffset of [0, 16]) {
    let recovered = null;
    try {
      recovered = attempt(ivOffset);
    } catch {
      /* expected */
    }
    assert.notEqual(
      recovered,
      "probe",
      `SHA-256 of the passphrase decrypted the ciphertext at IV offset ${ivOffset} — ` +
        "deriveKey has regressed to a fast hash",
    );
  }
});

test("#82 REJECT: a short key is refused rather than silently stretched", () => {
  assert.throws(
    () => cryptoMod.encryptSecret("x", "hunter2"),
    /too short/i,
    "a passphrase-length key must be refused",
  );
});

test("#82 REJECT: a long but low-variety key is refused", () => {
  assert.throws(
    () => cryptoMod.encryptSecret("x", "a".repeat(64)),
    /distinct characters/i,
    "a padded/repeated key must be refused",
  );
});

test("#82 REJECT: ciphertext in UPSTREAM's saltless envelope no longer decrypts", () => {
  // Documents the migration consequence rather than leaving it to be discovered:
  // the envelope gained a 16-byte salt prefix, so upstream ciphertext is not
  // readable by this code. Asserted so the breaking change is visible in a test
  // rather than only in a comment.
  const legacy = Buffer.concat([
    Buffer.alloc(12, 1), // iv
    Buffer.alloc(8, 2), // "ciphertext"
    Buffer.alloc(16, 3), // tag
  ]).toString("base64");
  assert.throws(() => cryptoMod.decryptSecret(legacy, GOOD_KEY));
});

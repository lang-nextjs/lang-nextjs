import * as crypto from "node:crypto";

/**
 * Encryption utility for GitHub tokens using AES-256-GCM
 *
 * This module provides secure encryption and decryption of GitHub access tokens
 * using AES-256-GCM encryption with authenticated encryption.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits (Standard for GCM)
const TAG_LENGTH = 16; // 128 bits

// ===== BEGIN lang-nextjs SECURITY PATCH (issue #82) — not upstream ===========
//
// Upstream at 3fb3ee1 derived the AES key as a SINGLE-PASS SHA-256 over an
// operator-supplied env var:
//
//     crypto.createHash("sha256").update(encryptionKey).digest()
//
// SHA-256 is a fast hash, not a key-derivation function. With no salt and no work
// factor, an operator who pastes a passphrase rather than 32 random bytes gets a
// key recoverable at billions of guesses per second, and the same passphrase
// yields the same key on every install. The docstring made it worse by describing
// this as a security property: "the encryption key (will be hashed to 256 bits)"
// reads as reassurance, and length is not the property that matters.
//
// scrypt gives the work factor and the salt. The salt is random PER ENCRYPTION
// and stored in the envelope, so two installs sharing a passphrase no longer
// share a key.
//
// ENVELOPE CHANGE, stated plainly: the format is now
//     SALT(16) || IV(12) || ciphertext || TAG(16)
// where upstream's was IV(12) || ciphertext || TAG(16). Ciphertext written by
// upstream's code CANNOT be read by this code. That is acceptable here because
// both the producer (the web app) and the consumer (the agent) live in this same
// vendored tree and this is a reference implementation with no persisted store —
// but anyone adopting this patch against live data needs a migration, not a
// drop-in.
const SALT_LENGTH = 16;
// scrypt cost. N=2^15 is ~100ms and ~32MB per derivation on a modern core, which
// is negligible for per-token operations and expensive for an offline guesser.
// maxmem must be raised above node's 32MB default or N=32768 throws.
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const KEY_LENGTH = 32;

/**
 * Rejects an encryption key that is obviously a human-chosen passphrase.
 *
 * DEFENCE IN DEPTH, NOT THE FIX. scrypt above is the fix; this exists so a weak
 * key fails loudly at the call site instead of silently producing a
 * cheap-to-crack ciphertext. It is deliberately a floor, not an entropy
 * estimator — it cannot tell a good key from a bad one, only an obviously bad one
 * from the rest, and anything cleverer would invite trusting it.
 */
function assertUsableEncryptionKey(encryptionKey: string): void {
  if (encryptionKey.length < 32) {
    throw new Error(
      "Encryption key is too short: expected at least 32 characters " +
        `(got ${encryptionKey.length}). Generate one with: openssl rand -hex 32`,
    );
  }
  const distinct = new Set(encryptionKey).size;
  if (distinct < 8) {
    throw new Error(
      `Encryption key has only ${distinct} distinct characters, which indicates ` +
        "a repeated or padded value rather than a random one. " +
        "Generate one with: openssl rand -hex 32",
    );
  }
}

/**
 * Derives a 256-bit AES key from the operator-supplied key and a per-ciphertext
 * salt, using scrypt.
 *
 * NOT a hash of the input. The salt must be stored alongside the ciphertext and
 * passed back in on decrypt.
 */
function deriveKey(encryptionKey: string, salt: Buffer): Buffer {
  return crypto.scryptSync(
    encryptionKey,
    salt,
    KEY_LENGTH,
    SCRYPT_PARAMS,
  ) as Buffer;
}
// ===== END lang-nextjs SECURITY PATCH (issue #82) ============================

/**
 * Encrypts a secret using AES-256-GCM
 *
 * @param secret - The secret to encrypt
 * @param encryptionKey - The operator's encryption key. Stretched with scrypt
 *   against a fresh random salt (lang-nextjs patch, issue #82). It is NOT merely
 *   hashed to 256 bits — the previous wording described length as though it were
 *   a security property. Must be >= 32 chars; use `openssl rand -hex 32`.
 * @returns Base64 encoded encrypted data containing IV, encrypted token, and auth tag
 * @throws Error if encryption fails or inputs are invalid
 */
export function encryptSecret(secret: string, encryptionKey: string): string {
  if (!secret || typeof secret !== "string") {
    throw new Error("Secret must be a non-empty string");
  }

  if (!encryptionKey || typeof encryptionKey !== "string") {
    throw new Error("Encryption key must be a non-empty string");
  }

  // lang-nextjs patch (#82): fail loudly on an obviously weak key.
  assertUsableEncryptionKey(encryptionKey);

  try {
    // Generate a random IV for each encryption (12 bytes for GCM)
    const iv = crypto.randomBytes(IV_LENGTH);

    // lang-nextjs patch (#82): fresh salt per ciphertext, stored in the envelope.
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = deriveKey(encryptionKey, salt);

    // Create cipher
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    // Encrypt the secret
    const encryptedBuffer = Buffer.concat([
      cipher.update(secret, "utf8"),
      cipher.final(),
    ]);

    // Get the authentication tag
    const tag = cipher.getAuthTag();

    // Combine salt, IV, encrypted data, and tag into a single base64 string.
    // lang-nextjs patch (#82) Format: SALT(16) + IV(12) + EncryptedData + TAG(16).
    // Upstream's format had no salt; see the patch banner at the top of this file.
    const combined = Buffer.concat([salt, iv, encryptedBuffer, tag]);
    return combined.toString("base64");
  } catch (error) {
    throw new Error(
      `Failed to encrypt secret: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Decrypts a secret using AES-256-GCM
 *
 * @param encryptedSecret - Base64 encoded encrypted data from encryptSecret
 * @param encryptionKey - The encryption key used for encryption
 * @returns The decrypted secret
 * @throws Error if decryption fails or inputs are invalid
 */
export function decryptSecret(
  encryptedSecret: string,
  encryptionKey: string,
): string {
  if (!encryptedSecret || typeof encryptedSecret !== "string") {
    throw new Error("Encrypted secret must be a non-empty string");
  }

  if (!encryptionKey || typeof encryptionKey !== "string") {
    throw new Error("Encryption key must be a non-empty string");
  }

  try {
    // Decode the combined data
    const combined = Buffer.from(encryptedSecret, "base64");

    // Minimum length: SALT + IV + TAG + 1 byte of data (lang-nextjs patch #82)
    if (combined.length < SALT_LENGTH + IV_LENGTH + TAG_LENGTH + 1) {
      throw new Error(
        "Invalid encrypted secret format: too short or malformed",
      );
    }

    // Extract IV, encrypted data, and tag
    // IV is first IV_LENGTH bytes
    // AuthTag is last TAG_LENGTH bytes
    // Encrypted data is in between
    // lang-nextjs patch (#82): salt is the first SALT_LENGTH bytes.
    const salt = combined.subarray(0, SALT_LENGTH);
    const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const tag = combined.subarray(combined.length - TAG_LENGTH);
    const encrypted = combined.subarray(
      SALT_LENGTH + IV_LENGTH,
      combined.length - TAG_LENGTH,
    );

    // Derive the encryption key from the stored salt
    const key = deriveKey(encryptionKey, salt);

    // Create decipher
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    // Decrypt the token
    // 'encrypted' is a Buffer, so no input encoding is specified for update()
    const decryptedBuffer = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return decryptedBuffer.toString("utf8");
  } catch (error) {
    throw new Error(
      `Failed to decrypt secret: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

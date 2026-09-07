import crypto from 'node:crypto';

/**
 * Authenticated symmetric encryption for a secret that has to be stored *and*
 * read back in plaintext.
 *
 * PA-28 introduces the first such secret in this codebase. Nothing existing was
 * reusable, and the absence is not an oversight: the only other secret in the
 * database is a webhook's HMAC key, and that one is deliberately plaintext
 * because verifying a MAC requires the raw key material, so there is nothing an
 * encryption layer there would protect against that would not also have to be
 * decryptable by the same process at the same moment.
 *
 * A custom Claude provider's API key is different only in *where* it goes: the
 * server hands it to a child process as `ANTHROPIC_AUTH_TOKEN`. That still means
 * the plaintext exists in this process, so this is not a secrets-manager
 * substitute and does not pretend to be — what it buys is that
 * `data/pocketagent.db`, which is backed up, copied between machines and read by
 * `sqlite3` far more casually than a `.env` is, stops holding third-party
 * credentials in the clear.
 *
 * AES-256-GCM specifically, because the ciphertext must be *authenticated*: an
 * unauthenticated mode would let a tampered row silently decrypt to a
 * different-but-valid-looking base URL credential. A wrong key or a mangled row
 * throws here rather than producing garbage.
 */

/** AES-256 takes exactly this many bytes of key. */
export const SECRET_KEY_BYTES = 32;

/** GCM's standard nonce length. 96 bits is what every implementation agrees on. */
const IV_BYTES = 12;

/** GCM tag length, in bytes. Node's default, stated so the parse can slice. */
const TAG_BYTES = 16;

export class SecretKeyError extends Error {
  override readonly name = 'SecretKeyError';
}

/**
 * The name the key is configured under. Referenced by the error messages and by
 * the store's "feature disabled" refusal, so all three cannot drift.
 */
export const SETTINGS_ENC_KEY_VAR = 'POCKETAGENT_SETTINGS_ENC_KEY';

export const SETTINGS_ENC_KEY_HELP = `
Generate one and store it in .env:

    node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

then add:

    ${SETTINGS_ENC_KEY_VAR}=<the generated value>
`.trim();

/**
 * Parse the base64 key from configuration, or `undefined` when it is unset.
 *
 * Unset is a valid state — the custom-provider feature is then disabled rather
 * than the server refusing to boot, so upgrading a deployment that has never
 * heard of this variable does not take it down (see the approved plan, §3.4).
 * Set-but-wrong is *not* a valid state and throws: a typo'd key would otherwise
 * silently disable a feature the operator believes they just enabled, and — far
 * worse — a key of the wrong length that happened to be accepted would make
 * every already-stored row permanently undecryptable.
 */
export function parseSettingsEncKey(raw: string | undefined): Buffer | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  let key: Buffer;
  try {
    key = Buffer.from(trimmed, 'base64');
  } catch {
    throw new SecretKeyError(`${SETTINGS_ENC_KEY_VAR} is not valid base64.\n\n${SETTINGS_ENC_KEY_HELP}`);
  }
  // `Buffer.from(x, 'base64')` never throws — it drops anything it cannot
  // decode — so the length check is what actually validates the input, and it
  // catches a truncated paste as well as a wrong-sized key.
  if (key.length !== SECRET_KEY_BYTES) {
    throw new SecretKeyError(
      `${SETTINGS_ENC_KEY_VAR} decodes to ${key.length} bytes; ` +
        `AES-256 needs exactly ${SECRET_KEY_BYTES}.\n\n${SETTINGS_ENC_KEY_HELP}`,
    );
  }
  return key;
}

/**
 * Encrypt `plaintext`, returning `base64(iv || authTag || ciphertext)`.
 *
 * One string rather than three columns: the IV and tag are meaningless without
 * the ciphertext and vice versa, so storing them apart only creates a way for a
 * migration or a hand-edit to separate them.
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  assertKey(key);
  // Fresh per call, never derived from anything: reusing an IV under one key is
  // the single catastrophic misuse of GCM.
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

/** Inverse of `encryptSecret`. Throws on a wrong key or a tampered payload. */
export function decryptSecret(payload: string, key: Buffer): string {
  assertKey(key);
  const raw = Buffer.from(payload, 'base64');
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new SecretKeyError('Encrypted value is truncated.');
  }
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  // `final()` is where a wrong key or a modified row fails, and it must be
  // allowed to throw: swallowing it would return a partially-decrypted string.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function assertKey(key: Buffer): void {
  if (key.length !== SECRET_KEY_BYTES) {
    throw new SecretKeyError(`Encryption key must be ${SECRET_KEY_BYTES} bytes, got ${key.length}.`);
  }
}

/**
 * Re-export of the shared secret-box primitive (PA-66).
 *
 * The implementation moved to `packages/node-kit` when `apps/hub` needed the
 * identical AES-256-GCM framing and the identical
 * `POCKETAGENT_SETTINGS_ENC_KEY` parsing contract. It is re-exported from its
 * original path rather than having ~15 call sites rewritten, because the move
 * is meant to be a *pure* one: the existing server suite is this refactor's
 * only regression guard, and it can only serve as one if nothing else in the
 * diff moved at the same time.
 *
 * The two processes never share a ciphertext. What they share, and what a
 * second copy would let drift, is the key length rule and the "unset disables,
 * set-but-wrong throws" boot contract — with one exception the Hub states for
 * itself: on the Hub the key is *required*, because encrypted credentials are
 * the whole product there rather than an optional extra. See
 * `apps/hub/src/config.ts`.
 */
export {
  SECRET_KEY_BYTES,
  SETTINGS_ENC_KEY_HELP,
  SETTINGS_ENC_KEY_VAR,
  SecretKeyError,
  decryptSecret,
  encryptSecret,
  parseSettingsEncKey,
} from '@pocketagent/node-kit';

import type { FastifyBaseLogger } from 'fastify';
import {
  DEFAULT_GEMINI_LIVE_IDLE_MINUTES,
  DEFAULT_GEMINI_LIVE_MODEL,
  type GeminiLiveSettingsDto,
  type UpdateGeminiLiveSettingsRequest,
} from '@pocketagent/protocol';
import type { Db } from '../db/index.js';
import { readSetting, writeSetting } from '../db/index.js';
import { SETTINGS_ENC_KEY_VAR, decryptSecret, encryptSecret } from '../crypto/secret-box.js';

/**
 * PA-96: the Gemini Live half of the server — the encrypted API key, the
 * feature's settings, and minting the constraint-locked ephemeral token the
 * browser opens its WebSocket with.
 *
 * REST `fetch` rather than `@google/genai`, the same posture
 * `voice/live-stt-client.ts` takes: the whole surface used is one POST, and
 * the SDK would add a large dependency to spell it. The request shape below
 * is what the SDK's own `authTokens.create` converter produces
 * (`bidiGenerateContentSetup` + `fieldMask`), and every field was verified
 * against the real service while building this.
 */

/** secret-box ciphertext of the AI Studio key. Never plaintext, anywhere. */
const GEMINI_API_KEY_KEY = 'planner_gemini_api_key_enc';
const GEMINI_LIVE_MODEL_KEY = 'planner_gemini_live_model';
const GEMINI_LIVE_VOICE_KEY = 'planner_gemini_live_voice';
const GEMINI_LIVE_IDLE_MINUTES_KEY = 'planner_gemini_live_idle_minutes';

export const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com';
/**
 * The *constrained* endpoint: the only one an ephemeral token opens, and the
 * one that enforces the token's locked setup. Ephemeral tokens exist only in
 * `v1alpha`, and only for AI Studio keys — a Vertex deployment would need the
 * server-relay design instead (see the exploration doc, §7 Q4).
 */
export const GEMINI_LIVE_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained';

/**
 * Single use: a token lifted out of the page after the browser has opened its
 * session is already spent. Verified empirically that *resuming* also consumes
 * a use, which is why every reconnect mints a fresh one rather than reusing.
 */
export const GEMINI_TOKEN_USES = 1;
/** The ticket's "≤30 min message window". */
export const GEMINI_TOKEN_TTL_MS = 30 * 60 * 1000;
/** The session must be opened within this — the browser connects immediately. */
export const GEMINI_TOKEN_NEW_SESSION_TTL_MS = 60 * 1000;

export class GeminiLiveError extends Error {
  override readonly name = 'GeminiLiveError';
  constructor(
    message: string,
    readonly code: 'not_configured' | 'encryption_unavailable' | 'upstream',
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/** One Gemini function declaration. `parametersJsonSchema` rather than
    `parameters`, because the planner's tool schemas are JSON Schema (they
    are sent to OpenAI-compatible endpoints verbatim) and the OpenAPI-subset
    `parameters` field would need a lossy conversion — all 35 built-in tool
    schemas were accepted as-is by the live service. */
export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
}

export interface GeminiLiveTokenInput {
  /** Without or with the `models/` prefix; normalised here. */
  model: string;
  voice: string | null;
  systemInstruction: string;
  functionDeclarations: readonly GeminiFunctionDeclaration[];
  resumeHandle?: string;
  now: number;
}

/** `models/<id>`, whichever way the operator typed it. */
export function normalizeGeminiModel(model: string): string {
  const trimmed = model.trim();
  return trimmed.startsWith('models/') ? trimmed : `models/${trimmed}`;
}

/**
 * The `POST v1alpha/auth_tokens` body. Pure, so the constraint set — which is
 * the security property of the whole browser-direct design — is asserted by a
 * unit test rather than trusted.
 *
 * `fieldMask` is deliberately absent. With a `bidiGenerateContentSetup`
 * present and no mask, the service locks *every* field of that setup, which
 * is the strictest option; a mask would instead lock only the fields it names
 * and leave the rest for the browser to set. Verified: with no mask, a client
 * `setup` naming a different model, system instruction or tool list is
 * overridden by the token's.
 *
 * Everything that shapes what the model is and may do is in here: model,
 * audio-only output, the system instruction (persona, memories, the live-mode
 * rules) and the exact tool list the planner would offer this agent. What is
 * *not* here is conversation history, which the browser replays as
 * `clientContent` after `setupComplete` — that is the user's own chat, so
 * letting the page send it grants nothing.
 */
export function buildGeminiLiveTokenRequest(input: GeminiLiveTokenInput): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = { responseModalities: ['AUDIO'] };
  if (input.voice) {
    generationConfig.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: input.voice } } };
  }
  const setup: Record<string, unknown> = {
    model: normalizeGeminiModel(input.model),
    generationConfig,
    systemInstruction: { parts: [{ text: input.systemInstruction }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // The handle has to be baked in here, not sent by the browser: under a
    // constrained token `sessionResumption` is locked, and a client-supplied
    // handle was observed to be silently ignored — the "resumed" session had
    // no memory of the conversation at all.
    sessionResumption: input.resumeHandle ? { handle: input.resumeHandle } : {},
    // Without it an audio session is capped at ~15 minutes; the sliding window
    // trades the oldest context for an unbounded session.
    contextWindowCompression: { slidingWindow: {} },
  };
  if (input.functionDeclarations.length > 0) {
    setup.tools = [{ functionDeclarations: input.functionDeclarations }];
  }
  return {
    uses: GEMINI_TOKEN_USES,
    expireTime: new Date(input.now + GEMINI_TOKEN_TTL_MS).toISOString(),
    newSessionExpireTime: new Date(input.now + GEMINI_TOKEN_NEW_SESSION_TTL_MS).toISOString(),
    bidiGenerateContentSetup: setup,
  };
}

export interface GeminiLiveServiceOptions {
  db: Db;
  /** `undefined` makes the feature unavailable without failing the boot. */
  encKey: Buffer | undefined;
  logger: Pick<FastifyBaseLogger, 'warn' | 'error' | 'info'>;
  /** Injected in tests so no real network call is ever made. */
  fetchImpl?: typeof fetch;
}

export interface MintedGeminiToken {
  token: string;
  model: string;
  expiresAt: number;
  newSessionExpiresAt: number;
}

/**
 * Owns the key and the settings. The key exists in plaintext in exactly two
 * places: the `PATCH` request body that sets it, and the `x-goog-api-key`
 * header of the one outbound mint request. It is never logged, never returned
 * by a route (no reveal endpoint — nothing outside this server ever needs it
 * back), and never stored unencrypted, the same boundary
 * `CustomClaudeProviderStore` and `TelegramBotStore` draw.
 */
export class GeminiLiveService {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GeminiLiveServiceOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (this.hasStoredKey() && opts.encKey === undefined) {
      opts.logger.warn(
        `${SETTINGS_ENC_KEY_VAR} is not set, so the stored Gemini API key cannot be used. ` +
          'Gemini Live stays unavailable until the key that encrypted it is configured.',
      );
    }
  }

  get encryptionAvailable(): boolean {
    return this.opts.encKey !== undefined;
  }

  settings(): GeminiLiveSettingsDto {
    const hasApiKey = this.hasStoredKey();
    const decrypts = hasApiKey && this.revealKey() !== null;
    return {
      encryptionAvailable: this.encryptionAvailable,
      hasApiKey,
      keyUnreadable: hasApiKey && !decrypts,
      available: decrypts,
      model: this.model(),
      voice: readSetting(this.opts.db, GEMINI_LIVE_VOICE_KEY) || null,
      idleMinutes: this.idleMinutes(),
    };
  }

  /** Whether a token could be minted right now. */
  isAvailable(): boolean {
    return this.revealKey() !== null;
  }

  update(req: UpdateGeminiLiveSettingsRequest): GeminiLiveSettingsDto {
    if (req.clearApiKey) {
      writeSetting(this.opts.db, GEMINI_API_KEY_KEY, '');
    } else if (req.apiKey !== undefined && req.apiKey.trim().length > 0) {
      if (this.opts.encKey === undefined) {
        throw new GeminiLiveError(
          `Set ${SETTINGS_ENC_KEY_VAR} to store a Gemini API key.`,
          'encryption_unavailable',
          409,
        );
      }
      writeSetting(this.opts.db, GEMINI_API_KEY_KEY, encryptSecret(req.apiKey.trim(), this.opts.encKey));
    }
    if (req.model !== undefined) {
      writeSetting(this.opts.db, GEMINI_LIVE_MODEL_KEY, req.model.replace(/^models\//, ''));
    }
    if (req.voice !== undefined) writeSetting(this.opts.db, GEMINI_LIVE_VOICE_KEY, req.voice ?? '');
    if (req.idleMinutes !== undefined) {
      writeSetting(this.opts.db, GEMINI_LIVE_IDLE_MINUTES_KEY, String(req.idleMinutes));
    }
    return this.settings();
  }

  model(): string {
    return readSetting(this.opts.db, GEMINI_LIVE_MODEL_KEY) || DEFAULT_GEMINI_LIVE_MODEL;
  }

  idleMinutes(): number {
    const raw = readSetting(this.opts.db, GEMINI_LIVE_IDLE_MINUTES_KEY);
    const parsed = raw === null || raw === '' ? NaN : Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_GEMINI_LIVE_IDLE_MINUTES;
  }

  /**
   * Mints one ephemeral token. The caller has already assembled the system
   * instruction and tool list from the chat's real context.
   */
  async mintToken(input: Omit<GeminiLiveTokenInput, 'model' | 'voice' | 'now'>): Promise<MintedGeminiToken> {
    const apiKey = this.revealKey();
    if (apiKey === null) {
      throw new GeminiLiveError(
        this.hasStoredKey()
          ? 'The stored Gemini API key cannot be decrypted. Re-enter it in Settings.'
          : 'Gemini Live is not configured. Add a Gemini API key in Settings.',
        'not_configured',
        409,
      );
    }
    const now = Date.now();
    const settings = this.settings();
    const body = buildGeminiLiveTokenRequest({ ...input, model: settings.model, voice: settings.voice, now });
    let res: Response;
    try {
      res = await this.fetchImpl(`${GEMINI_API_BASE_URL}/v1alpha/auth_tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new GeminiLiveError(`Could not reach Gemini: ${(err as Error).message}`, 'upstream', 502);
    }
    const text = await res.text();
    if (!res.ok) {
      // Google's error body names the problem (bad key, unknown model, a
      // schema it rejects) and never echoes the key, so it is safe to show.
      throw new GeminiLiveError(`Gemini refused to mint a token (${res.status}): ${summarizeGoogleError(text)}`, 'upstream', 502);
    }
    let name: unknown;
    try {
      name = (JSON.parse(text) as { name?: unknown }).name;
    } catch {
      name = undefined;
    }
    if (typeof name !== 'string' || !name.startsWith('auth_tokens/')) {
      throw new GeminiLiveError('Gemini answered the token request without a token.', 'upstream', 502);
    }
    return {
      token: name,
      model: normalizeGeminiModel(settings.model),
      expiresAt: now + GEMINI_TOKEN_TTL_MS,
      newSessionExpiresAt: now + GEMINI_TOKEN_NEW_SESSION_TTL_MS,
    };
  }

  private hasStoredKey(): boolean {
    return (readSetting(this.opts.db, GEMINI_API_KEY_KEY) ?? '').length > 0;
  }

  /** Internal only — never reachable through a route. `null` when there is no
      key or it will not decrypt, rather than throwing, so a rotated
      encryption key degrades the feature instead of failing requests. */
  private revealKey(): string | null {
    const ciphertext = readSetting(this.opts.db, GEMINI_API_KEY_KEY);
    if (!ciphertext || this.opts.encKey === undefined) return null;
    try {
      return decryptSecret(ciphertext, this.opts.encKey);
    } catch {
      this.opts.logger.error(
        `Could not decrypt the stored Gemini API key with the configured ${SETTINGS_ENC_KEY_VAR}. ` +
          'Re-enter it in Settings to repair it.',
      );
      return null;
    }
  }
}

function summarizeGoogleError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === 'string') return parsed.error.message.slice(0, 300);
  } catch {
    // fall through
  }
  return body.slice(0, 300) || 'no details';
}

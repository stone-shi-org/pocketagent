import type { ModelInfo } from '@pocketagent/protocol';
import type { AgentAdapter } from './types.js';
import { resolveExecutable } from './registry.js';

/**
 * Claude Code pointed at a third-party Anthropic-compatible endpoint.
 *
 * This is the *same binary* as the `claude` adapter, with an environment block
 * in front of it. That is the whole trick, and it is what makes the feature
 * possible at all: the provider swap happens below the CLI, and Claude Code
 * derives its transcript path from the cwd rather than from which API it
 * talked to. So `resumeAgentSessionId` + `forkSession: false` appends turns
 * from a third-party model to the *same* `~/.claude/projects/<cwd>/<id>.jsonl`
 * the Anthropic turns are in — verified end to end against DeepSeek before any
 * of this was written (PA-19): one transcript, `claude-sonnet-5` turns followed
 * by `deepseek-v4-flash` turns, with the model still able to recall a fact it
 * was told by the Anthropic half. It is the only cross-provider continuation
 * this architecture can offer, because `resumeAgentSessionId` is
 * agent-namespaced everywhere else.
 *
 * Deliberately no `structuredKind`: these variants must stay on the Claude
 * Agent SDK path (`StructuredSession`), since that is the path that owns the
 * shared transcript. A variant routed to any other engine would silently stop
 * being resumable from a `claude` conversation.
 *
 * The credential is read from configuration under a `POCKETAGENT_*` name and
 * re-emitted here as `ANTHROPIC_AUTH_TOKEN`. That indirection is not
 * cosmetic — `buildChildEnv` strips the entire `POCKETAGENT_` prefix from the
 * base environment, so the raw key never reaches an agent under the name it is
 * configured with, and `env | grep POCKET` in a shell session still shows
 * nothing.
 */
export interface ClaudeProviderOptions {
  id: string;
  displayName: string;
  description: string;
  /** The `claude` binary. Same one the stock adapter uses. */
  bin: string;
  /** Anthropic-shaped base URL, e.g. `https://api.deepseek.com/anthropic`. */
  baseUrl: string | null;
  /** Provider API key. Null (unconfigured) makes the adapter unavailable. */
  apiKey: string | null;
  /** Model id sent as `ANTHROPIC_MODEL`. */
  model: string | null;
  /**
   * Model id for the CLI's small-model slots. Claude Code uses a cheap model
   * for conversation titles and compaction summaries; if the gateway does not
   * know the id, those fail *mid-session* rather than at spawn, which reads as
   * a random breakage a long way from its cause.
   */
  smallModel: string | null;
  /** The picker's catalog for this variant. See `AgentAdapter.staticModels`. */
  staticModels: ModelInfo[];
  /** Human-readable name of the third party, for the disclosure banner. */
  providerLabel: string;
  /**
   * Whether a human has to be present — see `AgentAdapter.requiresAttendedUse`.
   *
   * Defaults to `true`, which is the PA-19 behaviour and the safe direction:
   * anything that builds a variant without saying otherwise is refused by the
   * unattended entry points. PA-28's per-provider `allowUnattended` toggle is
   * the only caller that ever passes `false`, and it is off by default in the
   * database, in the create request and in the editor.
   */
  requiresAttendedUse?: boolean;
}

export function createClaudeProviderAdapter(opts: ClaudeProviderOptions): AgentAdapter {
  const model = opts.model ?? null;
  // The small-model slots fall back to the main model rather than being left
  // unset: unset means the CLI uses its own Anthropic default id, which a
  // third-party gateway will reject.
  const smallModel = opts.smallModel ?? model;

  return {
    id: opts.id,
    displayName: opts.displayName,
    description: opts.description,
    // Same two transports as stock `claude` — it is the same CLI. Structured
    // stays the default for the same reason, and is also the only transport
    // that can resume a conversation.
    transports: ['structured', 'terminal'],
    defaultTransport: 'structured',
    supportsSkipPermissions: true,
    // Enforced rather than merely documented: see
    // `AgentAdapter.requiresAttendedUse`. `true` unless a PA-28 custom
    // provider explicitly opted out of it.
    requiresAttendedUse: opts.requiresAttendedUse ?? true,
    staticModels: opts.staticModels,
    providerDisclosure:
      `This session runs Claude Code against ${opts.providerLabel}, not Anthropic. ` +
      `Prompts and file contents from this directory are sent to that provider, and ` +
      `the cost figures below are computed with Anthropic pricing, so they are wrong.`,

    buildCommand(options) {
      const env: Record<string, string> = {};
      if (opts.baseUrl) env.ANTHROPIC_BASE_URL = opts.baseUrl;
      if (opts.apiKey) env.ANTHROPIC_AUTH_TOKEN = opts.apiKey;
      if (model) env.ANTHROPIC_MODEL = model;
      if (smallModel) {
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL = smallModel;
        env.ANTHROPIC_SMALL_FAST_MODEL = smallModel;
      }
      // Blanked, not left alone. `ANTHROPIC_AUTH_TOKEN` does win over
      // `ANTHROPIC_API_KEY` in the CLI's own precedence (checked against the
      // real binary), but relying on that would make this variant behave
      // differently on a box where the operator happens to export an Anthropic
      // key — and the failure would be a confusing auth error against the
      // wrong host. `buildChildEnv` cannot delete a variable, only set one, and
      // an empty value reads as absent to the CLI.
      env.ANTHROPIC_API_KEY = '';

      return {
        command: opts.bin,
        args: options.skipPermissions ? ['--dangerously-skip-permissions'] : [],
        env,
      };
    },

    isAvailable() {
      // Both halves matter, and neither is a spawn-time failure worth showing
      // as one: no key means the operator has not configured this provider, no
      // binary means Claude Code is not installed. Either way the row greys
      // out instead of offering a chat that cannot start.
      if (!opts.apiKey || !opts.baseUrl) return false;
      return resolveExecutable(opts.bin) !== null;
    },
  };
}

/**
 * Build a `ModelInfo` catalog from a comma-separated list of raw model ids.
 *
 * The ids are deliberately configuration rather than a hardcoded table. A
 * gateway's catalog is installation-specific — the omniroute instance this was
 * developed against rejects DeepSeek's own `deepseek-chat` as ambiguous and
 * wants its own ids (`deepseek-v4-flash`, `deepseek-v4-pro`) — so guessing
 * them here would produce a picker full of models the endpoint refuses. Take
 * them from the gateway's own `/models`.
 *
 * `supportsEffort` is false for every entry: effort is a Claude-model concept
 * the SDK maps onto Anthropic ids, and offering the control for a third-party
 * model would be a switch that silently does nothing.
 */
export function parseModelList(raw: string | null): ModelInfo[] {
  return modelListFrom(raw ? raw.split(',') : []);
}

/**
 * The same catalog builder, from an already-split list of ids.
 *
 * PA-28 stores a provider's models as a JSON array rather than a comma string,
 * so it needs this half; `parseModelList` keeps its comma-string signature for
 * the legacy-env migration path that still has one. Deliberately one
 * implementation and not two — trimming, de-duplication and first-seen ordering
 * are exactly the properties a picker depends on, and two copies would drift.
 */
export function modelListFrom(ids: readonly string[]): ModelInfo[] {
  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const entry of ids) {
    const value = entry.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    models.push({
      value,
      displayName: value,
      description: '',
      supportsEffort: false,
      supportedEffortLevels: [],
    });
  }
  return models;
}

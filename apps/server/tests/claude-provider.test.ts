import { describe, expect, it } from 'vitest';
import {
  customClaudeProviderId,
  isCustomClaudeProviderId,
  parseCustomClaudeProviderId,
  usesClaudeTranscripts,
} from '@pocketagent/protocol';
import {
  createClaudeProviderAdapter,
  modelListFrom,
  parseModelList,
  type ClaudeProviderOptions,
} from '../src/agents/claude-provider.js';
import { createClaudeAdapter } from '../src/agents/claude.js';
import { AgentRegistry, createDefaultRegistry } from '../src/agents/registry.js';
import { buildChildEnv } from '../src/sessions/env.js';
import { structuredAgentProblem } from '../src/routes/shared.js';

const REGISTRY_BINS = {
  shell: '/bin/bash',
  claudeBin: 'claude',
  agyBin: 'agy',
  opencodeBin: 'opencode',
  codexBin: 'codex',
  piBin: 'pi',
};

/** A provider id in the PA-28 reserved namespace, for the registry tests. */
const CUSTOM_ID = customClaudeProviderId('deepseek-abcd1234');

/**
 * PA-19: Claude Code driven against a third-party Anthropic-compatible
 * endpoint, so a conversation that hit an Anthropic rate limit can be
 * continued rather than abandoned.
 *
 * The behaviour these tests actually protect is the *separation*: the variant
 * exists, and stock `claude` is byte-for-byte what it was. Almost every way
 * this feature could go wrong is a leak across that line — an env override
 * reaching the wrong adapter, a key escaping under its configured name, or the
 * variant quietly becoming eligible for an unattended run.
 */

const OPTS: ClaudeProviderOptions = {
  id: CUSTOM_ID,
  displayName: 'Claude Code (DeepSeek)',
  description: 'Claude Code running against DeepSeek',
  providerLabel: 'DeepSeek',
  bin: 'claude',
  baseUrl: 'https://api.deepseek.com/anthropic',
  apiKey: 'sk-test-key',
  model: 'deepseek-v4-pro',
  smallModel: null,
  staticModels: parseModelList('deepseek-v4-pro,deepseek-v4-flash'),
};

const START = { cwd: '/tmp', cols: 80, rows: 24 };

describe('claude provider variants', () => {
  it('points the CLI at the third-party endpoint', () => {
    const env = createClaudeProviderAdapter(OPTS).buildCommand(START).env ?? {};
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test-key');
    expect(env.ANTHROPIC_MODEL).toBe('deepseek-v4-pro');
  });

  it('pins the small-model slots, falling back to the main model', () => {
    // Claude Code uses a cheap model for titles and compaction summaries. Left
    // unset it sends an Anthropic id the gateway does not know, and the failure
    // lands mid-session rather than at spawn.
    const env = createClaudeProviderAdapter(OPTS).buildCommand(START).env ?? {};
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-v4-pro');
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('deepseek-v4-pro');

    const explicit = createClaudeProviderAdapter({ ...OPTS, smallModel: 'deepseek-lite' })
      .buildCommand(START).env ?? {};
    expect(explicit.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-lite');
    expect(explicit.ANTHROPIC_MODEL).toBe('deepseek-v4-pro');
  });

  it('neutralizes an operator-exported Anthropic key', () => {
    // `ANTHROPIC_AUTH_TOKEN` does win in the CLI's own precedence, but the
    // variant must not behave differently depending on the server's ambient
    // environment. `buildChildEnv` cannot delete, so this blanks.
    const built = createClaudeProviderAdapter(OPTS).buildCommand(START);
    const env = buildChildEnv({
      cwd: '/tmp',
      overrides: built.env,
      base: { ANTHROPIC_API_KEY: 'sk-ant-operators-own-key' },
    });
    expect(env.ANTHROPIC_API_KEY).toBe('');
  });

  it('never leaks the key under its POCKETAGENT_ name', () => {
    // The whole reason the key is read as `POCKETAGENT_DEEPSEEK_API_KEY` and
    // re-emitted as `ANTHROPIC_AUTH_TOKEN`: `buildChildEnv` strips the
    // `POCKETAGENT_` namespace, so `env | grep POCKET` in a shell session must
    // still show nothing even though the value is present under another name.
    const built = createClaudeProviderAdapter(OPTS).buildCommand(START);
    const env = buildChildEnv({
      cwd: '/tmp',
      overrides: built.env,
      base: {
        POCKETAGENT_DEEPSEEK_API_KEY: 'sk-test-key',
        POCKETAGENT_AUTH_TOKEN: 'master-token',
      },
    });
    expect(Object.keys(env).some((k) => k.startsWith('POCKETAGENT_'))).toBe(false);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test-key');
  });

  it('keeps --dangerously-skip-permissions opt-in, exactly like stock claude', () => {
    const adapter = createClaudeProviderAdapter(OPTS);
    expect(adapter.buildCommand(START).args).toEqual([]);
    expect(adapter.buildCommand({ ...START, skipPermissions: true }).args).toEqual([
      '--dangerously-skip-permissions',
    ]);
  });

  it('is unavailable until both a key and a base URL are configured', () => {
    expect(createClaudeProviderAdapter({ ...OPTS, apiKey: null }).isAvailable?.()).toBe(false);
    expect(createClaudeProviderAdapter({ ...OPTS, baseUrl: null }).isAvailable?.()).toBe(false);
  });

  it('stays on the SDK path, which is what makes the shared transcript work', () => {
    // A `structuredKind` here would route the variant to a different engine and
    // silently break the one thing the feature exists for.
    expect(createClaudeProviderAdapter(OPTS).structuredKind).toBeUndefined();
  });

  it('declares its own model catalog instead of reporting Anthropic ids', () => {
    expect(createClaudeProviderAdapter(OPTS).staticModels?.map((m) => m.value)).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
    ]);
    // Effort is a Claude-model concept the SDK maps onto Anthropic ids; showing
    // the control for a third-party model would be a switch that does nothing.
    expect(createClaudeProviderAdapter(OPTS).staticModels?.every((m) => !m.supportsEffort)).toBe(
      true,
    );
  });

  it('discloses the provider persistently', () => {
    const disclosure = createClaudeProviderAdapter(OPTS).providerDisclosure ?? '';
    expect(disclosure).toContain('DeepSeek');
    // The transcript will hold turns from two providers with nothing marking
    // the seam, and the cost figures are Anthropic-priced. Both must be said.
    expect(disclosure).toMatch(/cost/i);
  });

  it('is refused by the unattended entry points unless it opts in', () => {
    // PA-19 made this unconditional. PA-28 keeps the *default* exactly as it
    // was and adds one per-provider opt-in, so both directions are asserted:
    // the block still exists, and lifting it is a deliberate act.
    const registry = createDefaultRegistry(REGISTRY_BINS);
    registry.registerCustomProvider({
      id: CUSTOM_ID,
      name: 'Claude Code (DeepSeek)',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'sk-test-key',
      models: ['deepseek-v4-pro'],
      defaultModel: 'deepseek-v4-pro',
      smallModel: null,
      allowUnattended: false,
    });

    expect(structuredAgentProblem(registry, CUSTOM_ID, 'scheduled')).toMatch(
      /third-party provider/,
    );
    expect(structuredAgentProblem(registry, CUSTOM_ID, 'triggered by a webhook')).toMatch(
      /third-party provider/,
    );
    // …while the agent it is a variant of stays perfectly eligible.
    expect(structuredAgentProblem(registry, 'claude', 'scheduled')).toBeNull();

    // Re-registering the same id with the flag on replaces the adapter live,
    // and the existing route check needs no branch to notice.
    registry.registerCustomProvider({
      id: CUSTOM_ID,
      name: 'Claude Code (DeepSeek)',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'sk-test-key',
      models: ['deepseek-v4-pro'],
      defaultModel: 'deepseek-v4-pro',
      smallModel: null,
      allowUnattended: true,
    });
    expect(structuredAgentProblem(registry, CUSTOM_ID, 'scheduled')).toBeNull();
    expect(structuredAgentProblem(registry, CUSTOM_ID, 'triggered by a webhook')).toBeNull();
  });

  it('defaults to attended-only when nothing says otherwise', () => {
    // The safe direction has to be the default: any future caller that builds
    // a variant without thinking about this gets the restriction.
    expect(createClaudeProviderAdapter(OPTS).requiresAttendedUse).toBe(true);
    expect(
      createClaudeProviderAdapter({ ...OPTS, requiresAttendedUse: false }).requiresAttendedUse,
    ).toBe(false);
  });

  it('leaves stock claude completely untouched', () => {
    // The regression that matters most. A `claude` session must not acquire an
    // environment block, a static catalog, a disclosure, or a restriction just
    // because a variant of it now exists.
    const claude = createClaudeAdapter('claude');
    expect(claude.buildCommand(START).env).toBeUndefined();
    expect(claude.staticModels).toBeUndefined();
    expect(claude.providerDisclosure).toBeUndefined();
    expect(claude.requiresAttendedUse).toBeUndefined();
  });

  it('registers no variants until one is created', () => {
    // PA-28: the default registry has no provider variants at all any more —
    // there is no env var left that could put one here.
    const registry = createDefaultRegistry(REGISTRY_BINS);
    expect(registry.list().map((a) => a.id)).toEqual([
      'claude',
      'agy',
      'opencode',
      'codex',
      'pi',
      'shell',
    ]);
  });

  it('registers a variant after claude, never before it', () => {
    // `ComposerPage` defaults to the first *available* agent, so a variant
    // appearing earlier in the list could become the default flavour for new
    // chats just by existing. Now that a provider can be created long after
    // boot, this is `AgentRegistry.list`'s own ordering rule rather than a
    // property of the order `createDefaultRegistry` happened to register in.
    const registry = createDefaultRegistry(REGISTRY_BINS);
    registry.registerCustomProvider({
      id: CUSTOM_ID,
      name: 'Claude Code (DeepSeek)',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'sk-test-key',
      models: ['deepseek-v4-pro'],
      defaultModel: 'deepseek-v4-pro',
      smallModel: null,
      allowUnattended: false,
    });
    const ids = registry.list().map((a) => a.id);
    expect(ids.indexOf('claude')).toBe(0);
    expect(ids.indexOf(CUSTOM_ID)).toBe(1);
    // And every built-in still follows, in its original order.
    expect(ids.slice(2)).toEqual(['agy', 'opencode', 'codex', 'pi', 'shell']);
  });

  it('unregisters a variant, and refuses to unregister anything else', () => {
    const registry = createDefaultRegistry(REGISTRY_BINS);
    registry.registerCustomProvider({
      id: CUSTOM_ID,
      name: 'p',
      baseUrl: 'https://example.test',
      apiKey: 'k',
      models: ['m'],
      defaultModel: 'm',
      smallModel: null,
      allowUnattended: false,
    });
    registry.unregisterCustomProvider(CUSTOM_ID);
    expect(registry.get(CUSTOM_ID)).toBeUndefined();

    // A built-in id passed here by mistake must not delete a real agent out of
    // the roster for the rest of the process's life.
    registry.unregisterCustomProvider('claude');
    expect(registry.get('claude')).toBeDefined();
  });

  it('builds the variant against the registry\'s own claude binary', () => {
    // The provider row carries no executable — a browser never supplies one —
    // so the registry has to remember which binary a variant is a variant of.
    const registry = new AgentRegistry('/opt/claude/bin/claude');
    registry.registerCustomProvider({
      id: CUSTOM_ID,
      name: 'p',
      baseUrl: 'https://example.test',
      apiKey: 'k',
      models: ['m'],
      defaultModel: 'm',
      smallModel: null,
      allowUnattended: false,
    });
    expect(registry.get(CUSTOM_ID)?.buildCommand(START).command).toBe('/opt/claude/bin/claude');
  });

  it('discloses the provider name and base URL, since the id says neither', () => {
    const registry = createDefaultRegistry(REGISTRY_BINS);
    registry.registerCustomProvider({
      id: CUSTOM_ID,
      name: 'House Gateway',
      baseUrl: 'https://gw.internal/anthropic',
      apiKey: 'k',
      models: ['m'],
      defaultModel: 'm',
      smallModel: null,
      allowUnattended: false,
    });
    const disclosure = registry.get(CUSTOM_ID)?.providerDisclosure ?? '';
    expect(disclosure).toContain('House Gateway');
    expect(disclosure).toContain('https://gw.internal/anthropic');
    expect(disclosure).toMatch(/cost/i);
  });
});

describe('parseModelList / modelListFrom', () => {
  it('is empty for an unconfigured catalog, so the SDK is asked as before', () => {
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList('')).toEqual([]);
    expect(parseModelList('  ,  ,')).toEqual([]);
    expect(modelListFrom([])).toEqual([]);
  });

  it('trims, drops blanks, and keeps first-seen order without duplicates', () => {
    expect(parseModelList(' a , b ,a,, c ').map((m) => m.value)).toEqual(['a', 'b', 'c']);
    // PA-28 stores models as an array rather than a comma string, and both
    // halves go through one implementation so a picker cannot get two answers.
    expect(modelListFrom([' a ', 'b', 'a', '', ' c ']).map((m) => m.value)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('the custom-provider id namespace', () => {
  it('round-trips, and rejects everything outside it', () => {
    expect(parseCustomClaudeProviderId(customClaudeProviderId('x-1'))).toBe('x-1');
    for (const id of ['claude', 'agy', 'codex', 'pocket:abc', 'custom-claude', '']) {
      expect(isCustomClaudeProviderId(id)).toBe(false);
    }
  });

  it('treats a truncated id as not-a-provider rather than as some provider', () => {
    // Degrades to "unknown agent", which is a clean refusal, instead of
    // resolving to whatever the empty string happens to match.
    expect(parseCustomClaudeProviderId('custom-claude:')).toBeNull();
  });

  it('cannot collide with a registry id, which is what makes one value space safe', () => {
    // Registry ids are bare lowercase words; the prefix carries a `:` precisely
    // so a row written before PA-28 can never parse as a custom provider.
    const registry = createDefaultRegistry(REGISTRY_BINS);
    for (const agent of registry.list()) {
      expect(isCustomClaudeProviderId(agent.id)).toBe(false);
    }
  });
});

describe('usesClaudeTranscripts', () => {
  it('covers every custom provider as well as stock claude', () => {
    // The single source of truth both sides read: the server decides who may
    // resume a conversation, the browser decides who to offer. PA-28 replaced
    // the hardcoded `['claude', 'claude-deepseek', 'claude-omniroute']` array
    // with a prefix test, because a user-created provider's id is minted at
    // runtime and is not enumerable at compile time.
    expect(usesClaudeTranscripts('claude')).toBe(true);
    expect(usesClaudeTranscripts(customClaudeProviderId('deepseek-abcd1234'))).toBe(true);
    expect(usesClaudeTranscripts(customClaudeProviderId('anything-at-all'))).toBe(true);
  });

  it('excludes every agent with its own conversation namespace', () => {
    for (const id of ['agy', 'opencode', 'codex', 'pi', 'shell']) {
      expect(usesClaudeTranscripts(id)).toBe(false);
    }
    // And the two retired hardcoded ids are no longer special. An old session
    // row still naming one keeps its transcript on disk, but the id itself
    // resolves to no agent, so nothing offers to continue it — which is the
    // honest state, not a regression: the provider it named is gone from the
    // registry until it is recreated in Settings.
    expect(usesClaudeTranscripts('claude-deepseek')).toBe(false);
    expect(usesClaudeTranscripts('claude-omniroute')).toBe(false);
  });
});

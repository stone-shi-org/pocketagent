import { describe, expect, it } from 'vitest';
import { usesClaudeTranscripts } from '@pocketagent/protocol';
import { loadConfig } from '../src/config/index.js';
import { makeWorkspace, TEST_TOKEN } from './helpers.js';
import {
  createClaudeProviderAdapter,
  parseModelList,
  type ClaudeProviderOptions,
} from '../src/agents/claude-provider.js';
import { createClaudeAdapter } from '../src/agents/claude.js';
import { createDefaultRegistry } from '../src/agents/registry.js';
import { buildChildEnv } from '../src/sessions/env.js';
import { structuredAgentProblem } from '../src/routes/shared.js';

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
  id: 'claude-deepseek',
  displayName: 'Claude Code (DeepSeek)',
  description: 'Claude Code running against DeepSeek',
  providerLabel: 'DeepSeek',
  bin: 'claude',
  baseUrl: 'https://api.deepseek.com/anthropic',
  apiKey: 'sk-test-key',
  model: 'deepseek-chat',
  smallModel: null,
  staticModels: parseModelList('deepseek-chat,deepseek-reasoner'),
};

const START = { cwd: '/tmp', cols: 80, rows: 24 };

describe('claude provider variants', () => {
  it('points the CLI at the third-party endpoint', () => {
    const env = createClaudeProviderAdapter(OPTS).buildCommand(START).env ?? {};
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test-key');
    expect(env.ANTHROPIC_MODEL).toBe('deepseek-chat');
  });

  it('pins the small-model slots, falling back to the main model', () => {
    // Claude Code uses a cheap model for titles and compaction summaries. Left
    // unset it sends an Anthropic id the gateway does not know, and the failure
    // lands mid-session rather than at spawn.
    const env = createClaudeProviderAdapter(OPTS).buildCommand(START).env ?? {};
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-chat');
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('deepseek-chat');

    const explicit = createClaudeProviderAdapter({ ...OPTS, smallModel: 'deepseek-lite' })
      .buildCommand(START).env ?? {};
    expect(explicit.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-lite');
    expect(explicit.ANTHROPIC_MODEL).toBe('deepseek-chat');
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
      'deepseek-chat',
      'deepseek-reasoner',
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

  it('is refused by the unattended entry points', () => {
    // Explicitly out of scope for PA-19: a variant would run on a timer or a
    // Jira webhook perfectly well, and that is the problem.
    const registry = createDefaultRegistry({
      shell: '/bin/bash',
      claudeBin: 'claude',
      agyBin: 'agy',
      opencodeBin: 'opencode',
      codexBin: 'codex',
      piBin: 'pi',
      claudeProviders: [
        {
          id: 'claude-deepseek',
          displayName: 'Claude Code (DeepSeek)',
          description: 'd',
          providerLabel: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com/anthropic',
          apiKey: 'sk-test-key',
          model: 'deepseek-chat',
          smallModel: null,
          models: 'deepseek-chat',
        },
      ],
    });

    expect(structuredAgentProblem(registry, 'claude-deepseek', 'scheduled')).toMatch(
      /third-party provider/,
    );
    expect(structuredAgentProblem(registry, 'claude-deepseek', 'triggered by a webhook')).toMatch(
      /third-party provider/,
    );
    // …while the agent it is a variant of stays perfectly eligible.
    expect(structuredAgentProblem(registry, 'claude', 'scheduled')).toBeNull();
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

  it('registers no variants when none are configured', () => {
    const registry = createDefaultRegistry({
      shell: '/bin/bash',
      claudeBin: 'claude',
      agyBin: 'agy',
      opencodeBin: 'opencode',
      codexBin: 'codex',
      piBin: 'pi',
    });
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
    // chats just by being configured.
    const registry = createDefaultRegistry({
      shell: '/bin/bash',
      claudeBin: 'claude',
      agyBin: 'agy',
      opencodeBin: 'opencode',
      codexBin: 'codex',
      piBin: 'pi',
      claudeProviders: [
        {
          id: 'claude-deepseek',
          displayName: 'Claude Code (DeepSeek)',
          description: 'd',
          providerLabel: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com/anthropic',
          apiKey: 'sk-test-key',
          model: 'deepseek-chat',
          smallModel: null,
          models: 'deepseek-chat',
        },
      ],
    });
    const ids = registry.list().map((a) => a.id);
    expect(ids.indexOf('claude')).toBe(0);
    expect(ids.indexOf('claude-deepseek')).toBe(1);
  });
});

describe('parseModelList', () => {
  it('is empty for an unconfigured catalog, so the SDK is asked as before', () => {
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList('')).toEqual([]);
    expect(parseModelList('  ,  ,')).toEqual([]);
  });

  it('trims, drops blanks, and keeps first-seen order without duplicates', () => {
    expect(parseModelList(' a , b ,a,, c ').map((m) => m.value)).toEqual(['a', 'b', 'c']);
  });
});

describe('the configured variant ids and the protocol list cannot drift', () => {
  it('every variant config declares an id the protocol recognises', () => {
    // `usesClaudeTranscripts` is deliberately an explicit list rather than a
    // `claude-` prefix test, which means adding a variant means editing two
    // files. This is the guard for forgetting the second one: a variant the
    // protocol does not recognise would be startable but would silently drop
    // out of the "Continue as…" picker and route its finished chats away from
    // the transcript preview — a confusing half-working state rather than a
    // clean failure.
    const ws = makeWorkspace();
    try {
      const config = loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        POCKETAGENT_AUTH_TOKEN: TEST_TOKEN,
        POCKETAGENT_WORKSPACE_ROOTS: ws.root,
      } as NodeJS.ProcessEnv);

      expect(config.claudeProviders.length).toBeGreaterThan(0);
      for (const provider of config.claudeProviders) {
        expect(
          usesClaudeTranscripts(provider.id),
          `${provider.id} is missing from CLAUDE_TRANSCRIPT_AGENT_IDS`,
        ).toBe(true);
      }
    } finally {
      ws.cleanup();
    }
  });

  it('leaves the variants unavailable when no key is configured', () => {
    // The providers are always *declared*; the key is what makes one usable.
    const ws = makeWorkspace();
    try {
      const config = loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        POCKETAGENT_AUTH_TOKEN: TEST_TOKEN,
        POCKETAGENT_WORKSPACE_ROOTS: ws.root,
      } as NodeJS.ProcessEnv);
      expect(config.claudeProviders.every((p) => p.apiKey === null)).toBe(true);
    } finally {
      ws.cleanup();
    }
  });
});

describe('usesClaudeTranscripts', () => {
  it('covers the variants as well as stock claude', () => {
    // The single source of truth both sides read: the server decides who may
    // resume a conversation, the browser decides who to offer.
    expect(usesClaudeTranscripts('claude')).toBe(true);
    expect(usesClaudeTranscripts('claude-deepseek')).toBe(true);
    expect(usesClaudeTranscripts('claude-omniroute')).toBe(true);
  });

  it('excludes every agent with its own conversation namespace', () => {
    for (const id of ['agy', 'opencode', 'codex', 'pi', 'shell']) {
      expect(usesClaudeTranscripts(id)).toBe(false);
    }
  });
});

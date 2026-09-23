import { z } from 'zod';

/**
 * On-demand agent CLI installation (PA-68).
 *
 * The thin container image (PA-64) ships no agent CLIs at all, so a freshly
 * bound backend has nothing to run. This is the shape of "which agents can
 * this server install, what state is each one in, and what happened while
 * installing one".
 *
 * ## Why the id space is closed here, in the protocol
 *
 * "The browser never supplies an executable or argv" is a standing invariant,
 * and installing an agent is arbitrary code execution as the server's user —
 * `npm install` runs the package's own `postinstall` scripts, and
 * `--ignore-scripts` would break most of these CLIs. So the request body may
 * not carry a package name, a version, a registry or a URL; it carries an id
 * out of a closed set, and the server owns the mapping from that id to an
 * argv.
 *
 * Putting the *ids* in the protocol (rather than only in the server's own
 * catalog module) is what lets `InstallAgentRequest` be a `z.enum`, so an
 * arbitrary package name is refused by request validation before any handler
 * runs. That is a stronger guarantee than a handler lookup: it cannot be
 * bypassed by a future refactor that forgets the check, and it is the form the
 * acceptance criterion asks for. The install *payload* — package name and
 * pinned version — deliberately stays server-side in
 * `apps/server/src/agents/catalog.ts`; the browser never needs it and never
 * sees it except as the human-readable `packageName`/`version` on the catalog
 * response, which is disclosure rather than input.
 */
export const INSTALLABLE_AGENT_IDS = ['claude', 'codex', 'opencode', 'pi'] as const;
export type InstallableAgentId = (typeof INSTALLABLE_AGENT_IDS)[number];

/**
 * `agy` is deliberately absent, and for a reason worth keeping written down:
 * Google's Antigravity CLI is distributed as a Google-published binary with no
 * npm package, and the registry names that look right (`agy`,
 * `antigravity-cli`) are unrelated 0.0.x placeholders. Pinning one would be a
 * supply-chain hazard disguised as completeness. `docker/agent-versions.env`
 * made the same call for the image's baked-in CLIs; this is the same decision
 * for on-demand installs, so the two cannot disagree about it.
 */
export const UNINSTALLABLE_AGENT_NOTES: Readonly<Record<string, string>> = Object.freeze({
  agy: 'Antigravity CLI is published by Google as a binary with no npm package, so it cannot be installed from here. Install it on the host and it will be detected automatically.',
});

/** The only install mechanism there is. See `AgentInstallMethod`'s doc comment. */
export const AgentInstallMethod = z.enum(['npm']);
export type AgentInstallMethod = z.infer<typeof AgentInstallMethod>;

/**
 * One entry of the server-declared catalog.
 *
 * `version` is the version this server would *install* — a pin the operator is
 * entitled to see before agreeing to run it. It is deliberately not the
 * version of an already-installed CLI: no adapter here has a verified
 * `--version` invocation, and `CodingAgentsSection` already declines to show
 * one rather than fabricate it. The two are different facts and conflating
 * them would make the dialog lie after the first upgrade.
 */
export const InstallableAgent = z.object({
  id: z.enum(INSTALLABLE_AGENT_IDS),
  displayName: z.string(),
  method: AgentInstallMethod,
  /** npm package name, shown so the operator can see what would be fetched. */
  packageName: z.string(),
  /** Pinned version, mirroring `docker/agent-versions.env`. */
  version: z.string(),
});
export type InstallableAgent = z.infer<typeof InstallableAgent>;

export const InstallableAgentListResponse = z.object({
  agents: z.array(InstallableAgent),
  /**
   * Absolute directory installs land in. Disclosed because it is the one thing
   * that decides whether an install survives a container restart (it must be
   * volume-backed) and whether the server will find the result at all —
   * `agents/registry.ts` searches a fixed set of directories.
   */
  prefix: z.string(),
  /**
   * True when an install would be written somewhere `resolveExecutable` does
   * not search, so the UI can refuse to offer it rather than run a install
   * whose result is invisible.
   */
  prefixDetectable: z.boolean(),
});
export type InstallableAgentListResponse = z.infer<typeof InstallableAgentListResponse>;

export const InstallAgentTarget = z.enum(['pinned', 'latest']);
export type InstallAgentTarget = z.infer<typeof InstallAgentTarget>;

/**
 * What a client may send to request an install or update. See this module's doc
 * comment for why `id` is a `z.enum` rather than a string the handler validates.
 */
export const InstallAgentRequest = z.object({
  id: z.enum(INSTALLABLE_AGENT_IDS),
  /**
   * PA-90: Whether to install the server-pinned catalog version or the
   * newest upstream release ('latest'). Defaults to 'pinned'.
   */
  target: InstallAgentTarget.optional(),
});
export type InstallAgentRequest = z.infer<typeof InstallAgentRequest>;

/**
 * Four states, not the three the ticket asked for.
 *
 * `not-installed` and `ready` are the obvious two, and `signed-out` is the one
 * the ticket exists to add — "installed" is not "authenticated", and an
 * operator who sees a tick and then gets a cryptic first-session failure has
 * been told the wrong thing.
 *
 * `unknown` is the fourth, and it is a real answer rather than a gap. Only
 * some of these CLIs can be asked about their login state non-interactively
 * and cheaply: `claude auth status` answers JSON, `codex login status` answers
 * a line of text, and `agy` has no such subcommand at all. Reporting `ready`
 * for an agent nobody probed would recreate exactly the failure above, and
 * reporting `signed-out` would nag an operator who is authenticated through an
 * environment variable — which is a real third path (`ANTHROPIC_API_KEY`, and
 * opencode reads `HF_TOKEN`), so the absence of a credential file proves
 * nothing either. `unknown` is rendered as a neutral state with its reason,
 * never as a green tick, the same way a host whose protocol version has not
 * been observed yet is `unknown` rather than assumed compatible.
 */
export const AgentSetupState = z.enum(['not-installed', 'signed-out', 'ready', 'unknown']);
export type AgentSetupState = z.infer<typeof AgentSetupState>;

/**
 * Progress from one install, streamed as SSE frames.
 *
 * A deliberately separate union from `AgentEvent` (`agent-events.ts`), which
 * is a *conversation* shape fed to the transcript reducer. Routing npm output
 * through `notice`/`text` would avoid one file at the cost of making a
 * transcript renderer responsible for install logs.
 */
export const AgentInstallStartedEvent = z.object({
  kind: z.literal('install_started'),
  id: z.enum(INSTALLABLE_AGENT_IDS),
  packageName: z.string(),
  version: z.string(),
  /** True when this stream attached to an install already in flight. */
  attached: z.boolean(),
});

export const AgentInstallLogEvent = z.object({
  kind: z.literal('install_log'),
  /** Monotonic within one install, so a re-attaching client can resume. */
  seq: z.number().int().positive(),
  text: z.string(),
  /** True when the log ring had already evicted earlier output. */
  truncated: z.boolean(),
});

export const AgentInstallFinishedEvent = z.object({
  kind: z.literal('install_finished'),
  ok: z.boolean(),
  /** The real failure, never a generic string. Null on success. */
  error: z.string().nullable(),
  /** Resulting state, re-derived after the install rather than assumed. */
  setupState: AgentSetupState,
});

export const AgentInstallEvent = z.discriminatedUnion('kind', [
  AgentInstallStartedEvent,
  AgentInstallLogEvent,
  AgentInstallFinishedEvent,
]);
export type AgentInstallEvent = z.infer<typeof AgentInstallEvent>;

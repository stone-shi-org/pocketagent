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
 * an official installer script downloads and runs a vendor binary, and an
 * `npm install` runs a package's own `postinstall` scripts. So the request
 * body may not carry a package name, a version, a registry, a URL or a path;
 * it carries an id out of a closed set plus an *action* out of another, and
 * the server owns the mapping from those to an argv.
 *
 * Putting the *ids* in the protocol (rather than only in the server's own
 * catalog module) is what lets `InstallAgentRequest` be a `z.enum`, so an
 * arbitrary package name is refused by request validation before any handler
 * runs. That is a stronger guarantee than a handler lookup: it cannot be
 * bypassed by a future refactor that forgets the check, and it is the form the
 * acceptance criterion asks for. The install *payload* — installer URL,
 * interpreter, fixed arguments — deliberately stays server-side in
 * `apps/server/src/agents/catalog.ts`; the browser sees it only as the
 * human-readable `source` on the catalog response, which is disclosure rather
 * than input.
 */
export const INSTALLABLE_AGENT_IDS = ['claude', 'codex', 'opencode', 'agy', 'pi'] as const;
export type InstallableAgentId = (typeof INSTALLABLE_AGENT_IDS)[number];

/**
 * Agents this server knows about but cannot install, with the reason shown in
 * the setup dialog.
 *
 * Empty since PA-104: `agy` was here because it has no npm package, and it
 * became installable the moment installs stopped being npm-only and started
 * using each agent's official installer. The map is kept because a future
 * adapter with neither an official installer nor a trustworthy package needs
 * exactly this, and the browser already renders it.
 */
export const UNINSTALLABLE_AGENT_NOTES: Readonly<Record<string, string>> = Object.freeze({});

/**
 * How an agent is installed (PA-104).
 *
 * `official-script` is the vendor's own installer (`claude.ai/install.sh`,
 * `chatgpt.com/codex/install.sh`, …), fetched from a fixed HTTPS URL the server
 * owns and run as `[interpreter, file, ...fixedArgs]`. It installs into the
 * agent's *official* location — the same one a human gets from a login shell —
 * which is the whole point: before PA-104, Settings put a second copy into
 * `~/.npm-global`, the server ran that one, and a human at the same shell ran
 * a different binary.
 *
 * `npm` remains only as the fallback for an agent with no official installer.
 * No agent currently in the catalog uses it.
 */
export const AgentInstallMethod = z.enum(['official-script', 'npm']);
export type AgentInstallMethod = z.infer<typeof AgentInstallMethod>;

/**
 * One entry of the server-declared catalog. Disclosure, never input.
 *
 * `source` is what the operator is agreeing to run: the installer URL for
 * `official-script`, the package name for `npm`. `version` is non-null only
 * when Settings would install a *specific* version; since PA-104 Settings
 * installs the vendor's current release for every official-script agent,
 * because they all update themselves and a pin would stop being true within a
 * day of the first run (`selfUpdating`). Pins survive only in
 * `docker/agent-versions.env`, for image builds, and only where the installer
 * accepts one (`pinnable`).
 */
export const InstallableAgent = z.object({
  id: z.enum(INSTALLABLE_AGENT_IDS),
  displayName: z.string(),
  method: AgentInstallMethod,
  source: z.string(),
  /** Kept for older bundles, which render `packageName@version`. Equal to `source`. */
  packageName: z.string(),
  version: z.string().nullable(),
  /** Whether the official installer can install a specific version (image builds use this). */
  pinnable: z.boolean(),
  /** Whether the agent updates itself once installed. */
  selfUpdating: z.boolean(),
  /** How "Update" works for this agent, in words — e.g. "runs `claude update`". */
  updateDescription: z.string(),
  /** Anything else the installer does that an operator should know before pressing Install. */
  notes: z.array(z.string()),
});
export type InstallableAgent = z.infer<typeof InstallableAgent>;

export const InstallableAgentListResponse = z.object({
  agents: z.array(InstallableAgent),
  /**
   * Where npm-method installs land (`agentInstallPrefix`). Since PA-104 no
   * catalogued agent installs there; it is still reported because it is where
   * leftover pre-PA-104 copies live, and those are what `otherCopies` flags.
   */
  prefix: z.string(),
  /**
   * True when an npm-method install into `prefix` would be found by the
   * server. Official-script installs do not depend on it.
   */
  prefixDetectable: z.boolean(),
});
export type InstallableAgentListResponse = z.infer<typeof InstallableAgentListResponse>;

/**
 * What a request asks for (PA-104).
 *
 * - `install`: run the official installer.
 * - `update`: update the copy that actually runs, in place — the agent's own
 *   update command (`claude update`, `codex update`, `agy update`,
 *   `pi update --self`), or the official installer again where there is none.
 *   Never a second copy somewhere else.
 * - `remove-prefix-copy`: `npm uninstall` a leftover copy from
 *   `agentInstallPrefix` — the pre-PA-104 Settings install, which is exactly
 *   the copy that caused this bug. Only ever that prefix, and only on an
 *   explicit click: copies elsewhere (`/usr/bin/codex`) are reported, never
 *   touched.
 *
 * `pinned` and `latest` are PA-90's values, accepted for one release as
 * aliases of `install` and `update`, because a browser bundle and a backend
 * behind a Hub can be briefly out of step.
 */
export const InstallAgentTarget = z.enum(['install', 'update', 'remove-prefix-copy', 'pinned', 'latest']);
export type InstallAgentTarget = z.infer<typeof InstallAgentTarget>;
export type InstallAgentAction = 'install' | 'update' | 'remove-prefix-copy';

export function installActionFor(target: InstallAgentTarget | undefined): InstallAgentAction {
  switch (target) {
    case 'update':
    case 'latest':
      return 'update';
    case 'remove-prefix-copy':
      return 'remove-prefix-copy';
    default:
      return 'install';
  }
}

/**
 * What a client may send to request an install, update or removal. See this
 * module's doc comment for why `id` is a `z.enum` rather than a string the
 * handler validates. `target` names an *action*, never a version or a path.
 */
export const InstallAgentRequest = z.object({
  id: z.enum(INSTALLABLE_AGENT_IDS),
  target: InstallAgentTarget.optional(),
});
export type InstallAgentRequest = z.infer<typeof InstallAgentRequest>;

/**
 * One copy of an agent's executable found on this host that is *not* the one
 * the server runs (PA-104).
 *
 * A copy earlier in the search order is the bug this ticket is about, so the
 * server reports every other copy rather than silently picking one. `kind`
 * says what it is and whether this server may remove it:
 *
 * - `install-prefix`: inside `agentInstallPrefix` (a pre-PA-104 Settings
 *   install). Removable on request.
 * - `image`: the container image's own baked-in install (the `claude`/`all`
 *   tags, under `AGENT_IMAGE_HOME`). It lives in a read-only image layer, so an
 *   update necessarily lands in the mounted `$HOME` instead and supersedes it —
 *   this is the expected state after the first update in a container, not a
 *   stray, and nothing can or should remove it. Informational only.
 * - `other`: anything else (`/usr/bin/codex` from a system npm). Report-only.
 */
export const AgentBinaryCopy = z.object({
  path: z.string(),
  realPath: z.string(),
  kind: z.enum(['install-prefix', 'image', 'other']),
});
export type AgentBinaryCopy = z.infer<typeof AgentBinaryCopy>;

/**
 * Four states, not the three the ticket asked for.
 *
 * `not-installed` and `ready` are the obvious two, and `signed-out` is the one
 * the ticket exists to add — "installed" is not "authenticated", and an
 * operator who sees a tick and then gets a cryptic first-session failure has
 * been told the wrong thing.
 *
 * `unknown` is the fourth, and it is a real answer rather than a gap. Only
 * some of these CLIs can be asked about their login state non-interactively:
 * `claude auth status` answers JSON, `codex login status` answers a line of
 * text, and `agy models` lists models when signed in and errors with
 * "Please sign in" when signed out (PA-146), while `pi` has no such subcommand
 * at all and `opencode auth list` only prints a decorated table. Reporting
 * `ready` for an agent nobody probed (or whose network call failed) would
 * recreate the failure above, and reporting `signed-out` would nag an operator
 * who is authenticated through an environment variable — which is a real third
 * path (`ANTHROPIC_API_KEY`, and opencode reads `HF_TOKEN`), so the absence of
 * a credential file proves nothing either. `unknown` is rendered as a neutral
 * state with its reason, never as a green tick, the same way a host whose
 * protocol version has not been observed yet is `unknown` rather than assumed
 * compatible.
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
  /** Kept for older bundles; equal to `source`. */
  packageName: z.string(),
  /** Installer URL, package name, or the update command being run. */
  source: z.string(),
  action: z.enum(['install', 'update', 'remove-prefix-copy']),
  version: z.string().nullable(),
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

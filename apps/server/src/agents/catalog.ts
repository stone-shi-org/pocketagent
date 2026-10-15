import path from 'node:path';
import type { InstallableAgent, InstallableAgentId } from '@pocketagent/protocol';
import { INSTALLABLE_AGENT_IDS } from '@pocketagent/protocol';

/**
 * What `POST /api/agents/install` is allowed to install, and how (PA-68,
 * reworked by PA-104).
 *
 * ## This is the whole of the server's trust in the client
 *
 * The request body carries an id out of `INSTALLABLE_AGENT_IDS` and an action
 * out of a second closed set — no package name, no version, no URL, no path —
 * and this table is the only thing that turns those into an argv. That is the
 * standing "the browser never supplies an executable or argv" invariant,
 * applied to the one place the server deliberately runs third-party code.
 *
 * ## Why the official installers, and what that costs (PA-104)
 *
 * PA-68 installed every agent with `npm install --prefix ~/.npm-global`, and
 * PA-92 then put that prefix first in `resolveExecutable`. The result on
 * stone-dev01 was two independent sets of CLIs: the server ran the npm copies,
 * a human's login shell ran the vendors' official installs in `~/.local/bin`,
 * and a Settings "upgrade" changed nothing a human at the same shell could
 * see — while the official copies kept updating themselves and the npm copy
 * never did. The fix is to install where the vendor installs, with the
 * vendor's own installer, and to update the copy that actually runs.
 *
 * Each vendor ships its installer as a shell script. PA-68's note here said a
 * `curl | bash` pipeline was strictly worse than a pinned registry version,
 * and part of that still stands, so the shape is deliberately narrower than
 * the vendors' own instructions:
 *
 * - the URL is a constant below, never input, and must be `https:`;
 * - the script is downloaded to a private temp file, its sha256 and size are
 *   written to the install log and the audit line, and it is run as
 *   `[interpreter, file, ...fixedArgs]` — argv only, no `-c`, no pipeline, no
 *   interpolation of anything a client sent;
 * - the child's environment is `buildChildEnv`'s (so `POCKETAGENT_*` is still
 *   stripped) plus fixed non-interactive switches, and it runs in its own
 *   session with no controlling terminal, so no installer can block on
 *   `/dev/tty` waiting for a human who is looking at a browser.
 *
 * What that does *not* change is the trade-off npm already had: the script is
 * a shell program that downloads and runs a vendor binary, as the server's
 * user. It is arbitrary code execution **by design**, exactly as an npm
 * `postinstall` is. The id check bounds *which* vendor's code runs, never what
 * it may do; the real boundary is this frozen table plus a human deliberately
 * pressing the button — which is why there is no create/edit route for it and
 * why no unattended trigger and no planner tool can reach the install service.
 *
 * There is deliberately **no pinned sha256 of the scripts**. They are edited
 * upstream without notice and themselves fetch "latest" (verifying the
 * artifact they download against a checksum from the same release), so a
 * pinned script hash would break on every upstream edit while protecting
 * nothing the script's own downloads do not already bypass. Recording the
 * hash of what actually ran is the honest version of that control.
 *
 * ## Pinning (PA-104)
 *
 * Settings installs the vendor's current release, never a pin: every agent
 * here updates itself (`selfUpdating`), so "installed = pinned" stops being
 * true within a day of the first run. Pins survive only in
 * `docker/agent-versions.env`, where a reproducible image is the point, and
 * only for installers that accept a version (`imageInstallArgs` non-null).
 * `agent-install.test.ts` fails if that file pins an agent this table says
 * cannot be pinned, or misses one it says can.
 *
 * Every script's behaviour recorded below was read from the script itself on
 * 2026-09-25, not from its documentation.
 */
export interface OfficialScriptEntry {
  method: 'official-script';
  displayName: string;
  /** The executable name, resolved through `resolveExecutable` after an install. */
  binName: string;
  scriptUrl: string;
  interpreter: 'bash' | 'sh';
  /** Platforms (`process.platform`) verified in the upstream installer script (PA-126). */
  supportedPlatforms: readonly NodeJS.Platform[];
  /** Fixed arguments for a Settings install: the vendor's current release. */
  installArgs: readonly string[];
  /**
   * Arguments that pin a version, for the image build only (`docker/Dockerfile`
   * mirrors these). Null when the installer cannot install a specific version.
   */
  imageInstallArgs: ((version: string) => string[]) | null;
  /** The `docker/agent-versions.env` variable holding that pin, when pinnable. */
  imagePinVar: string | null;
  /** Fixed, non-secret environment the installer needs to run unattended. */
  env: Readonly<Record<string, string>>;
  /**
   * How "Update" updates the copy that runs. `binary` runs the resolved
   * official executable with these arguments; `script` re-runs the official
   * installer, which every one of these updates in place.
   */
  update: { kind: 'binary'; args: readonly string[]; description: string } | { kind: 'script'; description: string };
  /**
   * Path fragments that identify an official install by its *real* path.
   * Matched against `fs.realpathSync` of the resolved binary, relative to any
   * home — the image installs under a build-time `HOME` (`docker/Dockerfile`),
   * and a fragment is what lets one rule cover both.
   */
  officialPathFragments: readonly string[];
  /**
   * The npm package a pre-PA-104 Settings install used, so a leftover copy in
   * the install prefix can be removed (`npm uninstall`). Null when there never
   * was one.
   */
  legacyNpmPackage: string | null;
  /**
   * Optional npm package publishing the current release numbers when it differs
   * from `legacyNpmPackage` (PA-153: opencode v2 publishes `@opencode/cli` while
   * pre-PA-104 prefix installs used `opencode-ai`).
   */
  npmVersionPackage?: string | null;
  /**
   * Directories under `$HOME` the installer or update writes, checked for
   * writability before anything runs (`homeWritabilityProblem`). Read off each
   * script and from what a real run created.
   */
  homeDirs: readonly string[];
  selfUpdating: boolean;
  notes: readonly string[];
}

/**
 * The fallback for an agent with no official installer. No catalogued agent
 * uses it today; it is kept because the ticket keeps npm for exactly that case
 * and the install service already knows how to drive it.
 */
export interface NpmEntry {
  method: 'npm';
  displayName: string;
  binName: string;
  packageName: string;
  version: string;
  supportedPlatforms?: readonly NodeJS.Platform[];
  imagePinVar: string | null;
  legacyNpmPackage: string;
  notes: readonly string[];
}

export type CatalogEntry = OfficialScriptEntry | NpmEntry;

const CATALOG: Readonly<Record<InstallableAgentId, CatalogEntry>> = Object.freeze({
  claude: {
    method: 'official-script',
    displayName: 'Claude Code',
    binName: 'claude',
    scriptUrl: 'https://claude.ai/install.sh',
    interpreter: 'bash',
    supportedPlatforms: ['linux', 'darwin'],
    // `install.sh [stable|latest|VERSION]`: the script downloads the latest
    // binary, verifies it against the release manifest's sha256, and hands
    // the optional target to `claude install`, which is what writes
    // `~/.local/share/claude/versions/<ver>` and links `~/.local/bin/claude`.
    // No argument is the vendor's default channel.
    installArgs: [],
    imageInstallArgs: (version) => [version],
    imagePinVar: 'CLAUDE_CODE_VERSION',
    env: {},
    update: { kind: 'binary', args: ['update'], description: 'Runs `claude update` on the copy that runs.' },
    officialPathFragments: ['/.local/share/claude/versions/'],
    legacyNpmPackage: '@anthropic-ai/claude-code',
    homeDirs: ['.local', '.local/bin', '.local/share', '.local/state', '.claude', '.cache'],
    selfUpdating: true,
    notes: ['Installs a native binary under ~/.local/share/claude and links ~/.local/bin/claude.'],
  },
  codex: {
    method: 'official-script',
    displayName: 'Codex',
    binName: 'codex',
    scriptUrl: 'https://chatgpt.com/codex/install.sh',
    interpreter: 'sh',
    supportedPlatforms: ['linux', 'darwin'],
    installArgs: [],
    // `--release <x.y.z|latest>`, validated by the script's own regex.
    imageInstallArgs: (version) => ['--release', version],
    imagePinVar: 'CODEX_VERSION',
    // Every prompt in the script (`prompt_yes_no`) answers "no" under this,
    // which matters twice: it never launches Codex at the end, and it never
    // runs its offered `sh -c "npm uninstall -g @openai/codex"` against a
    // conflicting copy — removing a copy is this server's explicit, separate
    // action (`remove-prefix-copy`), never a side effect of installing.
    env: { CODEX_NON_INTERACTIVE: '1' },
    // `codex update` exists, but its behaviour without a terminal was not
    // verifiable here; the installer's is, and it updates in place under
    // `~/.codex/packages/standalone` and relinks `~/.local/bin/codex`.
    update: { kind: 'script', description: 'Re-runs the official installer, which updates the standalone copy in place.' },
    officialPathFragments: ['/.codex/packages/standalone/'],
    legacyNpmPackage: '@openai/codex',
    homeDirs: ['.local', '.local/bin', '.codex'],
    selfUpdating: true,
    notes: [
      'Installs to ~/.codex/packages/standalone and links ~/.local/bin/codex.',
      'May add ~/.local/bin to your shell profile if it is not already on PATH.',
    ],
  },
  opencode: {
    method: 'official-script',
    displayName: 'opencode',
    binName: 'opencode',
    scriptUrl: 'https://opencode.ai/v2/install',
    interpreter: 'bash',
    supportedPlatforms: ['linux', 'darwin'],
    installArgs: [],
    imageInstallArgs: (version) => ['--version', version],
    imagePinVar: 'OPENCODE_VERSION',
    env: {},
    // The installer replaces `~/.opencode/bin/opencode` in place.
    update: { kind: 'script', description: 'Re-runs the official installer, which replaces ~/.opencode/bin/opencode in place.' },
    officialPathFragments: ['/.opencode/bin/opencode'],
    legacyNpmPackage: 'opencode-ai',
    npmVersionPackage: '@opencode/cli',
    homeDirs: ['.opencode', '.local', '.local/share', '.local/state', '.config', '.cache'],
    selfUpdating: true,
    notes: [
      'Installs ~/.opencode/bin/opencode.',
      'Adds ~/.opencode/bin to your shell profile if it is not already on PATH.',
    ],
  },
  agy: {
    method: 'official-script',
    displayName: 'Antigravity CLI',
    binName: 'agy',
    scriptUrl: 'https://antigravity.google/cli/install.sh',
    interpreter: 'bash',
    supportedPlatforms: ['linux', 'darwin'],
    installArgs: [],
    // The script always takes the latest release from its manifest.
    imageInstallArgs: null,
    imagePinVar: null,
    env: {},
    // The installer exits without doing anything when `agy` already exists,
    // so an update must be `agy update`.
    update: { kind: 'binary', args: ['update'], description: 'Runs `agy update` on the copy that runs.' },
    officialPathFragments: ['/.local/bin/agy'],
    legacyNpmPackage: null,
    homeDirs: ['.local', '.local/bin', '.cache'],
    selfUpdating: true,
    notes: [
      'Always installs the latest release; the version cannot be chosen.',
      'Runs `agy install` afterwards, which configures your shell.',
    ],
  },
  pi: {
    method: 'official-script',
    displayName: 'pi',
    binName: 'pi',
    scriptUrl: 'https://pi.dev/install.sh',
    interpreter: 'sh',
    supportedPlatforms: ['linux', 'darwin'],
    // Default "managed" mode: `npm ci --ignore-scripts` into
    // `~/.pi/agent/install`, then a launcher linked from the first of
    // `~/.pi/agent/bin`, `~/.local/bin`, … that is on PATH. With no terminal
    // it proceeds without its menu (`choose_pi_action`), and it refuses to
    // replace a pi it does not manage — which is reported, not worked around.
    installArgs: [],
    // Always the latest release from `pi.dev/api/installer/releases/latest`.
    imageInstallArgs: null,
    imagePinVar: null,
    env: {},
    update: {
      kind: 'binary',
      // `--no-approve` ignores project-local files; the installer's cwd is
      // `os.tmpdir()` anyway, but a trust prompt is the one thing that could
      // wait for input here.
      args: ['update', '--self', '--no-approve'],
      description: 'Runs `pi update --self` on the copy that runs.',
    },
    // Managed mode, or legacy mode's `npm -g --prefix ~/.local` (how pi.dev's
    // script installed it on stone-dev01). Not `~/.npm-global/...`: that is
    // the pre-PA-104 Settings copy this ticket exists to stop running.
    officialPathFragments: ['/.pi/agent/', '/.local/lib/node_modules/@earendil-works/pi-coding-agent/'],
    legacyNpmPackage: '@earendil-works/pi-coding-agent',
    homeDirs: ['.pi', '.local', '.local/bin'],
    selfUpdating: false,
    notes: [
      'Needs Node.js 22.19 or newer and npm on the server’s PATH.',
      'Always installs the latest release; the version cannot be chosen.',
      'Refuses to replace a pi it did not install — remove that copy first.',
    ],
  },
});

/** The catalog as the browser sees it: disclosure of what would run, never input. */
export function installableAgents(): InstallableAgent[] {
  return INSTALLABLE_AGENT_IDS.map((id) => {
    const entry = CATALOG[id];
    const source = entry.method === 'npm' ? entry.packageName : entry.scriptUrl;
    return {
      id,
      displayName: entry.displayName,
      method: entry.method,
      source,
      packageName: source,
      version: entry.method === 'npm' ? entry.version : null,
      pinnable: entry.method === 'npm' ? true : entry.imageInstallArgs !== null,
      selfUpdating: entry.method === 'npm' ? false : entry.selfUpdating,
      updateDescription:
        entry.method === 'npm' ? `Installs ${entry.packageName}@latest into the install prefix.` : entry.update.description,
      notes: [...entry.notes],
    };
  });
}

export function catalogEntry(id: InstallableAgentId): CatalogEntry {
  return CATALOG[id];
}

/**
 * Whether an installer entry supports the current OS platform (PA-126).
 * Returns a clear refusal reason when it does not, or `null` when supported.
 */
export function catalogPlatformProblem(
  entry: CatalogEntry,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const supported = entry.supportedPlatforms;
  if (!supported || supported.includes(platform)) return null;
  return (
    `The official installer for ${entry.displayName} does not support platform "${platform}" ` +
    `(supported platforms: ${supported.join(', ')}).`
  );
}

/**
 * Whether a resolved binary's *real* path is this agent's official install.
 *
 * This is what makes PA-104's rule enforceable rather than a log line: after
 * an install or update the copy that runs must pass this, or the job fails
 * naming the copy that runs instead. An npm-method agent's official location
 * is its prefix, which the install service checks itself.
 */
export function isOfficialInstallPath(id: InstallableAgentId, realPath: string): boolean {
  const entry = CATALOG[id];
  if (entry.method !== 'official-script') return false;
  const normalized = path.resolve(realPath);
  return entry.officialPathFragments.some((fragment) =>
    fragment.endsWith('/') ? normalized.includes(fragment) : normalized.endsWith(fragment),
  );
}

/**
 * The argv for one npm-method install, and the environment override that aims
 * it. Kept for the npm fallback; see `NpmEntry`.
 *
 * Two details are empirical rather than stylistic, and both cost a broken
 * install if dropped. **`cwd` must be outside any package-managed project**:
 * on a host where `npm` is a corepack shim, corepack hard-fails any `npm` call
 * inside a project declaring another manager, and this repository declares
 * pnpm — so the install service runs it in `usageProbeCwd()`
 * (`COREPACK_ENABLE_STRICT=0` is belt and braces). **The prefix is set
 * twice**, by flag and by `NPM_CONFIG_PREFIX`, because npm reads its env
 * config case-insensitively and an inherited `NPM_CONFIG_PREFIX` would
 * otherwise compete with the flag.
 */
export function npmInstallCommand(
  entry: NpmEntry,
  prefix: string,
  target: 'pinned' | 'latest' = 'pinned',
): { args: string[]; env: Record<string, string> } {
  const pkgSpec = target === 'latest' ? `${entry.packageName}@latest` : `${entry.packageName}@${entry.version}`;
  return {
    args: ['install', '--global', `--prefix=${prefix}`, '--no-fund', '--no-audit', pkgSpec],
    env: { NPM_CONFIG_PREFIX: prefix, COREPACK_ENABLE_STRICT: '0' },
  };
}

/**
 * The argv that removes a leftover npm copy from the install prefix — the
 * pre-PA-104 Settings install. Only ever `--prefix=<agentInstallPrefix>`, so
 * it cannot reach a system npm's global directory (`/usr/lib/node_modules`),
 * which is report-only.
 */
export function npmUninstallCommand(
  packageName: string,
  prefix: string,
): { args: string[]; env: Record<string, string> } {
  return {
    args: ['uninstall', '--global', `--prefix=${prefix}`, '--no-fund', '--no-audit', packageName],
    env: { NPM_CONFIG_PREFIX: prefix, COREPACK_ENABLE_STRICT: '0' },
  };
}

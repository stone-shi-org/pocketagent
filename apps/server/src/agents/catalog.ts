import type { InstallableAgent, InstallableAgentId } from '@pocketagent/protocol';
import { INSTALLABLE_AGENT_IDS } from '@pocketagent/protocol';

/**
 * What `POST /api/agents/install` is allowed to install (PA-68).
 *
 * ## This is the whole of the server's trust in the client
 *
 * The request body carries an id out of `INSTALLABLE_AGENT_IDS` and nothing
 * else — no package name, no version, no registry, no URL — and this table is
 * the only thing that turns that id into an argv. That is the existing "the
 * browser never supplies an executable or argv" invariant, applied to a new
 * kind of execution.
 *
 * It is worth being precise about what that does *not* buy, because the
 * temptation is to read an enum as a safety proof. `npm install` runs the
 * package's own `postinstall` scripts as the server's user, and
 * `--ignore-scripts` breaks most of these CLIs, so an install is arbitrary
 * code execution by design. The id check bounds *which* package runs, not what
 * it may do. The real boundary is this pinned table plus an operator
 * deliberately asking for it — which is why the versions are pinned rather
 * than floating on `latest`, why there is no create/edit route for this table,
 * and why no unattended trigger and no planner tool can reach the install
 * service.
 *
 * ## Why npm is the only method
 *
 * Every entry below is a published npm package. The alternative channels these
 * CLIs also offer are native installers fetched through a shell pipeline
 * (`curl … | bash`), which would mean executing unverified remote code from a
 * URL the operator never sees — strictly worse than a pinned registry version,
 * and it would need a shell where everything else here is argv-only. If a
 * future agent has *only* a native installer, the shape that fits this
 * codebase is a `download` method with a pinned sha256 (fetch, verify, chmod,
 * atomic rename), not a pipe into an interpreter.
 *
 * ## Pins mirror the image, and a test enforces it
 *
 * These versions are the same pins `docker/agent-versions.env` bakes into the
 * `claude`/`all` image targets. They are duplicated here rather than read from
 * that file at runtime because the runtime image does not ship `docker/` — but
 * `agent-catalog.test.ts` parses that file and fails when the two disagree, so
 * a bump stays a one-file change in practice and the duplication cannot rot
 * silently. That is the same discipline PA-65 applies to the four
 * `package.json` versions.
 */
interface CatalogEntry {
  displayName: string;
  packageName: string;
  version: string;
  /**
   * The executable npm's `--prefix <p>` drops into `<p>/bin`. Checked with a
   * real `resolveExecutable` after the install rather than trusting the exit
   * code — `docker/Dockerfile` carries a `test -x` for exactly this reason,
   * having shipped an install that "succeeded" into the wrong prefix once.
   */
  binName: string;
}

const CATALOG: Readonly<Record<InstallableAgentId, CatalogEntry>> = Object.freeze({
  claude: {
    displayName: 'Claude Code',
    packageName: '@anthropic-ai/claude-code',
    version: '2.1.274',
    binName: 'claude',
  },
  codex: {
    displayName: 'Codex',
    packageName: '@openai/codex',
    version: '0.154.0',
    binName: 'codex',
  },
  opencode: {
    displayName: 'opencode',
    packageName: 'opencode-ai',
    version: '1.18.31',
    binName: 'opencode',
  },
  pi: {
    displayName: 'pi',
    packageName: '@earendil-works/pi-coding-agent',
    version: '0.85.1',
    binName: 'pi',
  },
});

/** The catalog as the browser sees it: disclosure of what would be fetched, never input. */
export function installableAgents(): InstallableAgent[] {
  return INSTALLABLE_AGENT_IDS.map((id) => ({
    id,
    displayName: CATALOG[id].displayName,
    method: 'npm' as const,
    packageName: CATALOG[id].packageName,
    version: CATALOG[id].version,
  }));
}

export function catalogEntry(id: InstallableAgentId): CatalogEntry {
  return CATALOG[id];
}

/**
 * The argv for one install, and the environment override that aims it.
 *
 * Two details are empirical rather than stylistic, and both cost a broken
 * install if dropped.
 *
 * **`cwd` must be outside any package-managed project.** On a host where `npm`
 * is a corepack shim — Debian's `nodejs` packaging, among others — corepack
 * reads the nearest `package.json`'s `packageManager` field and *hard-fails*
 * any `npm` invocation inside a project that declares a different manager
 * (`Usage Error: This project is configured to use pnpm`). The server's own cwd
 * is this repository, which declares pnpm, so an installer inheriting
 * `process.cwd()` fails 100% of the time in development. `usageProbeCwd()`
 * (`os.tmpdir()`) is already the required cwd for every headless CLI call here
 * for an unrelated reason, and it fixes this one for free.
 * `COREPACK_ENABLE_STRICT=0` is set as well, belt and braces; the neutral cwd
 * is the actual fix.
 *
 * **The prefix is set twice, deliberately.** `--prefix` on the command line
 * *and* `NPM_CONFIG_PREFIX` in the child environment. npm reads its
 * environment config case-insensitively, so an inherited `NPM_CONFIG_PREFIX`
 * is a real competitor to a command-line flag — the Dockerfile has to
 * `env -u NPM_CONFIG_PREFIX` to install anywhere *other* than it. Here the two
 * agree by construction, which removes the precedence question instead of
 * relying on an answer to it.
 */
export function npmInstallCommand(
  id: InstallableAgentId,
  prefix: string,
  target: 'pinned' | 'latest' = 'pinned',
): { args: string[]; env: Record<string, string> } {
  const entry = CATALOG[id];
  const pkgSpec = target === 'latest' ? `${entry.packageName}@latest` : `${entry.packageName}@${entry.version}`;
  return {
    args: [
      'install',
      '--global',
      `--prefix=${prefix}`,
      '--no-fund',
      '--no-audit',
      // A package name is never interpolated from client input: `entry` came
      // out of the frozen table above, keyed by a validated enum member.
      pkgSpec,
    ],
    env: { NPM_CONFIG_PREFIX: prefix, COREPACK_ENABLE_STRICT: '0' },
  };
}

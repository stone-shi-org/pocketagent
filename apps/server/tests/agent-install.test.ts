import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, AgentInstallEvent, InstallableAgentListResponse } from '@pocketagent/protocol';
import { INSTALLABLE_AGENT_IDS, installActionFor } from '@pocketagent/protocol';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/index.js';
import { catalogEntry, catalogPlatformProblem, installableAgents, isOfficialInstallPath } from '../src/agents/catalog.js';
import { deriveSetupState, probeAgentAuth } from '../src/agents/auth-probe.js';
import {
  agentBinaryReport,
  homeWritabilityProblem,
  installFailure,
  officialInstallerPath,
  outputTail,
  type InstallRunner,
  type ScriptFetcher,
} from '../src/agents/install.js';
import {
  agentBinSearchDirs,
  executableSearchDirs,
  resolveExecutable,
  setAgentInstallPrefixSource,
  wrapLoginShellCommand,
} from '../src/agents/registry.js';
import { agyFileTokenStorageEnv, createAgyAdapter } from '../src/agents/agy.js';
import { createClaudeAdapter } from '../src/agents/claude.js';
import { createCodexAdapter } from '../src/agents/codex.js';
import { createOpencodeAdapter } from '../src/agents/opencode.js';
import { authHeaders, createTestApp, makeConfig, makeWorkspace, TEST_TOKEN, type TestApp } from './helpers.js';

/**
 * Reverses the SSE wire format, exactly as `planner-chats.test.ts` does.
 * `app.inject()` buffers a hijacked stream, so the whole frame sequence
 * arrives as one payload — which is what makes every acceptance criterion
 * here testable with no live server and no real install.
 *
 * Heartbeat comment frames (`: ping`) are dropped: they are not `data:`
 * frames and carry no JSON, which is precisely why a comment was chosen for
 * the keep-alive.
 */
function parseEvents(payload: string): AgentInstallEvent[] {
  return payload
    .split('\n\n')
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && c.startsWith('data:'))
    .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')) as AgentInstallEvent);
}

/**
 * A throwaway `$HOME` and `$PATH`, so resolution is driven entirely by
 * fixtures and never by which agents happen to be installed on the machine
 * running the tests — this one has a real `~/.local/bin/claude` *and* a
 * leftover `~/.npm-global/bin/claude`, which is PA-104's bug in miniature.
 */
interface FakeHost {
  home: string;
  pathDir: string;
  /** Write an executable (a tiny sh script printing `output`) at `rel` under `home`. */
  exe: (rel: string, output?: string) => string;
  /** Symlink `rel` under `home` to `target` (absolute or home-relative). */
  link: (rel: string, target: string) => string;
  restore: () => void;
}

function fakeHost(): FakeHost {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pa104-home-')));
  const pathDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pa104-path-')));
  const origPath = process.env.PATH;
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  process.env.PATH = pathDir;
  const abs = (rel: string): string => (path.isAbsolute(rel) ? rel : path.join(home, rel));
  return {
    home,
    pathDir,
    exe: (rel, output = '1.0.0') => {
      const file = abs(rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `#!/bin/sh\necho ${output}\n`, { mode: 0o755 });
      return file;
    },
    link: (rel, target) => {
      const file = abs(rel);
      mkdirSync(path.dirname(file), { recursive: true });
      symlinkSync(abs(target), file);
      return file;
    },
    restore: () => {
      process.env.PATH = origPath;
      setAgentInstallPrefixSource(() => []);
      vi.restoreAllMocks();
      rmSync(home, { recursive: true, force: true });
      rmSync(pathDir, { recursive: true, force: true });
    },
  };
}

/** Pins in docker/agent-versions.env for image tooling rather than an agent
    (`playwright-cli` in the `all` target). */
const IMAGE_TOOL_PINS = ['PLAYWRIGHT_CLI_VERSION'];

describe('agent install catalog', () => {
  /**
   * PA-104's pinning model, enforced: pins exist only for image builds, and
   * only for installers that take a version. The file and this table are
   * deliberately separate (the runtime image does not ship `docker/`), so
   * this is what keeps them honest in both directions — a pin for an agent
   * whose installer cannot honour it would be a lie baked into `-all`, and a
   * pinnable agent with no pin would float silently.
   */
  it('pins in docker/agent-versions.env exactly the agents whose installer takes a version', () => {
    const envPath = path.resolve(import.meta.dirname, '../../../docker/agent-versions.env');
    const pins = new Map<string, string>();
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const match = /^([A-Z0-9_]+)=(.+)$/.exec(line.trim());
      if (match?.[1] && match[2]) pins.set(match[1], match[2].trim());
    }
    const expected = new Set<string>();
    for (const id of INSTALLABLE_AGENT_IDS) {
      const entry = catalogEntry(id);
      if (entry.method !== 'official-script') continue;
      if (entry.imageInstallArgs === null) {
        expect(entry.imagePinVar, id).toBeNull();
        continue;
      }
      expect(entry.imagePinVar, id).not.toBeNull();
      expected.add(entry.imagePinVar as string);
      expect(pins.get(entry.imagePinVar as string), id).toMatch(/^\d+\.\d+\.\d+/);
    }
    // Image tooling that is not an agent, so no catalog entry names it. Listed
    // here rather than ignored by pattern, so a stray pin still fails.
    for (const toolPin of IMAGE_TOOL_PINS) {
      expect(pins.get(toolPin), toolPin).toMatch(/^\d+\.\d+\.\d+/);
      expected.add(toolPin);
    }
    expect([...pins.keys()].sort()).toEqual([...expected].sort());
  });

  it('has the Dockerfile and docker/build.sh consume every non-agent image pin', () => {
    const dockerfile = readFileSync(path.resolve(import.meta.dirname, '../../../docker/Dockerfile'), 'utf8');
    const buildSh = readFileSync(path.resolve(import.meta.dirname, '../../../docker/build.sh'), 'utf8');
    for (const toolPin of IMAGE_TOOL_PINS) {
      expect(dockerfile, toolPin).toContain(`ARG ${toolPin}`);
      expect(buildSh, toolPin).toContain(`--build-arg "${toolPin}=\${${toolPin}}"`);
    }
  });

  /**
   * The Dockerfile passes each pin to the installer itself; if it named a
   * variable the env file no longer sets, `docker/build.sh` would pass an
   * empty value and the build's own `test -n` would be the first to notice.
   */
  it('has the Dockerfile consume every pin', () => {
    const dockerfile = readFileSync(path.resolve(import.meta.dirname, '../../../docker/Dockerfile'), 'utf8');
    for (const id of INSTALLABLE_AGENT_IDS) {
      const entry = catalogEntry(id);
      if (entry.method === 'official-script' && entry.imagePinVar !== null) {
        expect(dockerfile, id).toContain(`ARG ${entry.imagePinVar}`);
      }
    }
  });

  /** agy has an official installer now, so the old "no npm package" exclusion is gone. */
  it('offers every agent with an official installer, agy included', () => {
    expect([...INSTALLABLE_AGENT_IDS].sort()).toEqual(['agy', 'claude', 'codex', 'opencode', 'pi']);
    expect(installableAgents().map((a) => a.id).sort()).toEqual([...INSTALLABLE_AGENT_IDS].sort());
  });

  /**
   * The disclosure is the installer URL — what the operator is agreeing to
   * run — and never a version, because Settings installs the vendor's current
   * release (they all update themselves).
   */
  it('discloses the official installer URL and no pinned version', () => {
    for (const agent of installableAgents()) {
      expect(agent.method).toBe('official-script');
      expect(agent.source).toMatch(/^https:\/\//);
      expect(agent.packageName).toBe(agent.source);
      expect(agent.version).toBeNull();
      expect(agent.updateDescription.length).toBeGreaterThan(0);
    }
    const bySource = Object.fromEntries(installableAgents().map((a) => [a.id, a.source]));
    expect(bySource).toEqual({
      claude: 'https://claude.ai/install.sh',
      codex: 'https://chatgpt.com/codex/install.sh',
      opencode: 'https://opencode.ai/v2/install',
      agy: 'https://antigravity.google/cli/install.sh',
      pi: 'https://pi.dev/install.sh',
    });
  });

  it('discloses which installers cannot pin a version', () => {
    const pinnable = Object.fromEntries(installableAgents().map((a) => [a.id, a.pinnable]));
    expect(pinnable).toEqual({ claude: true, codex: true, opencode: true, agy: false, pi: false });
  });

  it('never builds a shell command', () => {
    for (const id of INSTALLABLE_AGENT_IDS) {
      const entry = catalogEntry(id);
      if (entry.method !== 'official-script') continue;
      expect(['bash', 'sh']).toContain(entry.interpreter);
      const argv = [
        ...entry.installArgs,
        ...(entry.imageInstallArgs?.('1.2.3') ?? []),
        ...(entry.update.kind === 'binary' ? entry.update.args : []),
      ];
      for (const arg of argv) expect(arg, id).not.toMatch(/[;&|`$><\s]/);
    }
  });

  /** Codex's installer offers to `npm uninstall` a conflicting copy; that must be answered "no". */
  it('runs codex non-interactively, so it never removes anything itself', () => {
    const codex = catalogEntry('codex');
    expect(codex.method === 'official-script' && codex.env.CODEX_NON_INTERACTIVE).toBe('1');
  });

  it('maps PA-90 targets onto actions', () => {
    expect(installActionFor(undefined)).toBe('install');
    expect(installActionFor('pinned')).toBe('install');
    expect(installActionFor('latest')).toBe('update');
    expect(installActionFor('update')).toBe('update');
    expect(installActionFor('remove-prefix-copy')).toBe('remove-prefix-copy');
  });
});

describe('official install locations', () => {
  /**
   * The paths are the real ones read off stone-dev01 on 2026-09-25 — the
   * official copies *and* the pre-PA-104 npm copies that shadowed them.
   */
  it('recognises each official layout and rejects the npm-prefix copies', () => {
    const h = '/home/u';
    expect(isOfficialInstallPath('claude', `${h}/.local/share/claude/versions/2.1.282`)).toBe(true);
    expect(isOfficialInstallPath('claude', `${h}/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js`)).toBe(false);
    expect(
      isOfficialInstallPath('codex', `${h}/.codex/packages/standalone/releases/0.157.0-x86_64-unknown-linux-musl/bin/codex`),
    ).toBe(true);
    expect(isOfficialInstallPath('codex', '/usr/lib/node_modules/@openai/codex/bin/codex.js')).toBe(false);
    expect(isOfficialInstallPath('opencode', `${h}/.opencode/bin/opencode`)).toBe(true);
    expect(isOfficialInstallPath('agy', `${h}/.local/bin/agy`)).toBe(true);
    expect(isOfficialInstallPath('agy', '/usr/bin/agy')).toBe(false);
    expect(isOfficialInstallPath('pi', `${h}/.pi/agent/install/releases/0.86.0/node_modules/.bin/pi`)).toBe(true);
    expect(
      isOfficialInstallPath('pi', `${h}/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`),
    ).toBe(true);
    expect(
      isOfficialInstallPath('pi', `${h}/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`),
    ).toBe(false);
  });

  /** The image installs under a build-time HOME; one rule has to cover both. */
  it('recognises an official layout under any home', () => {
    expect(isOfficialInstallPath('claude', '/opt/pocketagent-agents/.local/share/claude/versions/2.1.274')).toBe(true);
  });
});

describe('executable resolution (PA-104)', () => {
  let host: FakeHost;
  beforeEach(() => {
    host = fakeHost();
  });
  afterEach(() => host.restore());

  /** THE bug: a leftover Settings copy used to win over the official one. */
  it('runs the official copy, never a leftover ~/.npm-global copy', () => {
    const official = host.link('.local/bin/claude', '.local/share/claude/versions/2.1.282');
    host.exe('.local/share/claude/versions/2.1.282', '2.1.282');
    host.exe('.npm-global/bin/claude', '2.1.274');
    expect(resolveExecutable('claude')).toBe(official);
  });

  /**
   * A service manager's PATH carries `/usr/bin`, where stale system-npm
   * copies live; a login shell puts the official directories first, and so
   * must the server.
   */
  it('prefers the official directories over the server PATH', () => {
    host.exe(path.join(host.pathDir, 'codex'), '0.147.0');
    const official = host.exe('.local/bin/codex', '0.157.0');
    expect(resolveExecutable('codex')).toBe(official);
  });

  /** The container image used to put the prefix first on PATH; its position there is ignored. */
  it('demotes the install prefix even when PATH lists it first', () => {
    const prefixBin = path.join(host.home, '.npm-global', 'bin');
    process.env.PATH = `${prefixBin}${path.delimiter}${host.pathDir}`;
    host.exe('.npm-global/bin/pi');
    const onPath = host.exe(path.join(host.pathDir, 'pi'));
    expect(resolveExecutable('pi')).toBe(onPath);
    expect(executableSearchDirs().at(-1)).toBe(prefixBin);
  });

  it('still finds an npm-prefix copy when it is the only one', () => {
    const only = host.exe('.npm-global/bin/pi');
    expect(resolveExecutable('pi')).toBe(only);
  });

  it('demotes a configured prefix, but never an official directory', () => {
    const custom = path.join(host.home, 'agents');
    setAgentInstallPrefixSource(() => [custom]);
    process.env.PATH = `${path.join(custom, 'bin')}${path.delimiter}${host.pathDir}`;
    host.exe('agents/bin/opencode');
    const onPath = host.exe(path.join(host.pathDir, 'opencode'));
    expect(resolveExecutable('opencode')).toBe(onPath);

    // An operator who pointed the prefix at ~/.local must not lose ~/.local/bin.
    setAgentInstallPrefixSource(() => [path.join(host.home, '.local')]);
    const official = host.exe('.local/bin/opencode');
    expect(resolveExecutable('opencode')).toBe(official);
  });

  it('keeps every official directory in the extra search list', () => {
    const dirs = agentBinSearchDirs();
    for (const rel of ['.opencode/bin', '.local/bin', '.pi/agent/bin', '.npm-global/bin']) {
      expect(dirs).toContain(path.join(host.home, rel));
    }
  });

  /**
   * An installer's PATH must not contain the prefix: opencode's exits early
   * when *any* opencode on PATH has the requested version, and pi's refuses to
   * proceed past a pi it does not manage. It must contain ~/.local/bin (pi
   * links into the first candidate directory on PATH), and must *not* contain
   * ~/.opencode/bin — found by running the real installer: with it listed,
   * opencode's installer decided the shell was already configured and never
   * wrote its PATH line, so a human's shell could not find it.
   */
  it('gives installers a login-like PATH: ~/.local/bin, no install prefix, no vendor dirs', () => {
    process.env.PATH = `${path.join(host.home, '.npm-global', 'bin')}${path.delimiter}${host.pathDir}`;
    const dirs = officialInstallerPath().split(path.delimiter);
    expect(dirs[0]).toBe(path.join(host.home, '.local', 'bin'));
    expect(dirs).toContain(host.pathDir);
    expect(dirs).not.toContain(path.join(host.home, '.npm-global', 'bin'));
    expect(dirs).not.toContain(path.join(host.home, '.opencode', 'bin'));
    expect(dirs).not.toContain(path.join(host.home, '.pi', 'agent', 'bin'));
    expect(dirs).toContain(path.dirname(process.execPath));
  });

  it('reports the copy that runs, whether it is official, and every other copy', () => {
    host.link('.local/bin/codex', '.codex/packages/standalone/releases/0.157.0/bin/codex');
    host.exe('.codex/packages/standalone/releases/0.157.0/bin/codex', '0.157.0');
    host.exe('.npm-global/bin/codex', '0.157.0');
    const system = host.exe(path.join(host.pathDir, 'codex'), '0.147.0');
    // A second link to the *same* file is not a second copy.
    host.link('.pi/agent/bin/codex', '.codex/packages/standalone/releases/0.157.0/bin/codex');

    const report = agentBinaryReport('codex', 'codex');
    expect(report.resolvedPath).toBe(path.join(host.home, '.local/bin/codex'));
    expect(report.officialInstall).toBe(true);
    expect(report.otherCopies).toEqual([
      { path: system, realPath: system, kind: 'other' },
      {
        path: path.join(host.home, '.npm-global/bin/codex'),
        realPath: path.join(host.home, '.npm-global/bin/codex'),
        kind: 'install-prefix',
      },
    ]);
  });

  /**
   * A container's baked-in copy (under AGENT_IMAGE_HOME) is its own kind: after
   * an update the running copy is the one in $HOME, and the image's is an
   * expected, unremovable baseline rather than a stray.
   */
  it('classifies the image’s baked-in copy as image, not other', () => {
    const imageHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pa104-img-')));
    const orig = process.env.AGENT_IMAGE_HOME;
    process.env.AGENT_IMAGE_HOME = imageHome;
    try {
      host.link('.local/bin/claude', '.local/share/claude/versions/2.1.283');
      host.exe('.local/share/claude/versions/2.1.283', '2.1.283');
      const baked = host.exe(path.join(imageHome, '.local/share/claude/versions/2.1.274'), '2.1.274');
      const onPath = path.join(host.pathDir, 'claude');
      symlinkSync(baked, onPath);
      const report = agentBinaryReport('claude', 'claude');
      expect(report.resolvedPath).toBe(path.join(host.home, '.local/bin/claude'));
      expect(report.otherCopies).toEqual([{ path: onPath, realPath: baked, kind: 'image' }]);
    } finally {
      if (orig === undefined) delete process.env.AGENT_IMAGE_HOME;
      else process.env.AGENT_IMAGE_HOME = orig;
      rmSync(imageHome, { recursive: true, force: true });
    }
  });

  it('says a non-official copy is not official', () => {
    host.exe('.npm-global/bin/claude');
    expect(agentBinaryReport('claude', 'claude').officialInstall).toBe(false);
    // Outside the install catalog nothing is reported — the agent list never
    // exposes a command line (sessions.test.ts guards the shell's).
    expect(agentBinaryReport('shell', 'sh')).toEqual({ resolvedPath: null, officialInstall: null, otherCopies: [] });
    expect(agentBinaryReport('claude', 'definitely-missing-xyz')).toEqual({
      resolvedPath: null,
      officialInstall: null,
      otherCopies: [],
    });
  });
});

describe('home writability preflight (PA-104)', () => {
  let host: FakeHost;
  beforeEach(() => {
    host = fakeHost();
  });
  afterEach(() => host.restore());

  it('passes a writable home, including directories that do not exist yet', () => {
    expect(homeWritabilityProblem(['.local', '.local/bin', '.codex'])).toBeNull();
  });

  it.skipIf(process.getuid?.() === 0)('names only the outermost unwritable directory', () => {
    const local = path.join(host.home, '.local');
    mkdirSync(path.join(local, 'share'), { recursive: true });
    chmodSync(path.join(local, 'share'), 0o555);
    chmodSync(local, 0o555);
    try {
      const problem = homeWritabilityProblem(['.local', '.local/bin', '.local/share']);
      expect(problem).toContain(`chown -R ${process.getuid?.()}:${process.getgid?.()} ${local}\``);
      // ~/.local/bin does not exist, so it is judged by ~/.local; and
      // ~/.local/share is covered by the chown of ~/.local.
      expect(problem?.split(local).length).toBe(3);
    } finally {
      chmodSync(path.join(local, 'share'), 0o755);
      chmodSync(local, 0o755);
    }
  });

  it('keeps the useful tail of noisy output', () => {
    expect(outputTail('a\n\n\x1b[1mb\x1b[0m\r\nc\nd\n')).toBe('b / c / d');
    expect(outputTail('x'.repeat(1000))).toHaveLength(401);
    expect(outputTail('')).toBe('');
  });
});

describe('image PATH matches the resolver (PA-104)', () => {
  /**
   * The server and a login shell inside the container have to pick the same
   * binary, so the image's PATH (for the server) and the two login-shell
   * snippets (for `exec_command`, which runs `$SHELL -lc`, and for a human
   * doing `docker exec … bash -l`) must list directories in the order
   * `executableSearchDirs` searches them: official locations, then the system
   * PATH, then ~/.cargo/bin, then the npm install prefix last.
   */
  it('lists the same directories in the same order', () => {
    const home = '/home/pocketagent';
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    const origPath = process.env.PATH;
    process.env.PATH = '/usr/local/bin:/usr/bin';
    try {
      const dirs = executableSearchDirs('linux');
      const expected = [
        ...dirs.slice(0, 3),
        '$PATH',
        ...dirs.slice(-2),
      ];
      expect(dirs.slice(3, -2)).toEqual(['/usr/local/bin', '/usr/bin']);
      const dockerfile = readFileSync(path.resolve(import.meta.dirname, '../../../docker/Dockerfile'), 'utf8');
      const envPath = /^ENV PATH=(\S+)$/m.exec(dockerfile)?.[1];
      expect(envPath?.split(':')).toEqual(expected);
      const snippets = [...dockerfile.matchAll(/'PATH="([^"]+)"'/g)].map((m) => m[1]);
      expect(snippets).toHaveLength(2);
      for (const snippet of snippets) {
        expect(snippet?.replaceAll('$HOME', home).split(':')).toEqual(expected);
      }
    } finally {
      process.env.PATH = origPath;
      vi.restoreAllMocks();
    }
  });

  it('places /opt/homebrew/bin and /usr/local/bin ahead of /usr/bin on darwin even when launchd starts with a minimal PATH (PA-126)', () => {
    const home = '/Users/pocketagent';
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    const origPath = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    try {
      const dirs = executableSearchDirs('darwin');
      expect(dirs.slice(0, 5)).toEqual([
        '/Users/pocketagent/.opencode/bin',
        '/Users/pocketagent/.local/bin',
        '/Users/pocketagent/.pi/agent/bin',
        '/opt/homebrew/bin',
        '/usr/local/bin',
      ]);
      expect(dirs.indexOf('/opt/homebrew/bin')).toBeLessThan(dirs.indexOf('/usr/bin'));
      expect(dirs.at(-1)).toBe('/Users/pocketagent/.npm-global/bin');

      const installerDirs = officialInstallerPath('darwin').split(path.delimiter);
      expect(installerDirs.slice(0, 5)).toEqual([
        '/Users/pocketagent/.local/bin',
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
      ]);

      const wrapped = wrapLoginShellCommand('/bin/zsh', 'claude --version', 'darwin');
      expect(wrapped).toContain(
        `export PATH='/Users/pocketagent/.opencode/bin':` +
          `'/Users/pocketagent/.local/bin':` +
          `'/Users/pocketagent/.pi/agent/bin':` +
          `'/opt/homebrew/bin':` +
          `'/usr/local/bin':"$PATH":` +
          `'/Users/pocketagent/.cargo/bin':` +
          `'/Users/pocketagent/.npm-global/bin'\nclaude --version`,
      );
      // Non-POSIX shells are left unwrapped.
      expect(wrapLoginShellCommand('/opt/homebrew/bin/fish', 'claude --version', 'darwin')).toBe(
        'claude --version',
      );
    } finally {
      process.env.PATH = origPath;
      vi.restoreAllMocks();
    }
  });

  it('recognizes macOS official install layouts and refuses unsupported platforms with a clear reason (PA-126)', () => {
    expect(isOfficialInstallPath('claude', '/Users/me/.local/share/claude/versions/2.1.112')).toBe(true);
    expect(isOfficialInstallPath('codex', '/Users/me/.codex/packages/standalone/codex-aarch64-apple-darwin/codex')).toBe(
      true,
    );
    expect(isOfficialInstallPath('opencode', '/Users/me/.opencode/bin/opencode')).toBe(true);
    expect(isOfficialInstallPath('agy', '/Users/me/.local/bin/agy')).toBe(true);
    expect(isOfficialInstallPath('pi', '/Users/me/.pi/agent/install/node_modules/.bin/pi')).toBe(true);

    for (const id of INSTALLABLE_AGENT_IDS) {
      const entry = catalogEntry(id);
      expect(catalogPlatformProblem(entry, 'linux'), id).toBeNull();
      expect(catalogPlatformProblem(entry, 'darwin'), id).toBeNull();
      expect(catalogPlatformProblem(entry, 'win32'), id).toMatch(
        /does not support platform "win32" \(supported platforms: linux, darwin\)/,
      );
    }
  });
});

describe('install failure reporting', () => {
  /**
   * Acceptance criterion: a failure surfaces the real error. The three ways
   * this goes wrong are different problems with different fixes, so they must
   * not collapse into one string.
   */
  it('distinguishes the command missing, failing, and timing out', () => {
    expect(installFailure({ code: null, timedOut: false, startError: 'ENOENT' }, 'npm')).toMatch(/Could not run npm/);
    expect(installFailure({ code: null, timedOut: false, startError: 'ENOENT' }, 'bash')).toMatch(/Could not run bash/);
    expect(installFailure({ code: 1, timedOut: false, startError: null }, 'The official installer')).toMatch(
      /exited with code 1/,
    );
    expect(installFailure({ code: null, timedOut: true, startError: null }, 'npm')).toMatch(/longer than/);
    expect(installFailure({ code: 0, timedOut: false, startError: null }, 'npm')).toBeNull();
  });
});

describe('setup state derivation', () => {
  /**
   * `available` wins outright. A cached `ready` from before someone deleted
   * the binary must read as `not-installed`: the whole point of the state
   * model is that an operator is never told an agent is usable when it is not.
   */
  it('reports not-installed even when a probe once said ready', () => {
    expect(deriveSetupState(false, { state: 'ready', detail: 'Signed in' })).toEqual({
      setupState: 'not-installed',
      setupDetail: null,
    });
  });

  it('reports unknown when nothing has been probed', () => {
    expect(deriveSetupState(true, null).setupState).toBe('unknown');
    expect(deriveSetupState(true, { state: null, detail: null }).setupState).toBe('unknown');
  });

  it('never upgrades an unknown probe result to ready', () => {
    expect(deriveSetupState(true, { state: 'unknown', detail: 'no subcommand' })).toEqual({
      setupState: 'unknown',
      setupDetail: 'no subcommand',
    });
  });

  it('carries a signed-out reason through so it is actionable', () => {
    expect(deriveSetupState(true, { state: 'signed-out', detail: 'Run `codex login`' })).toEqual({
      setupState: 'signed-out',
      setupDetail: 'Run `codex login`',
    });
  });
});

describe('auth probe interpretation', () => {
  const agy = createAgyAdapter('agy');
  const claude = createClaudeAdapter('claude');
  const codex = createCodexAdapter('codex');
  const opencode = createOpencodeAdapter('opencode');

  /**
   * Driven with recorded output rather than a real credentialed CLI, which is
   * the entire reason `authProbe.interpret` is a pure function instead of a
   * method that spawns. The `ready` sample is real output from
   * `claude auth status` on the development host.
   */
  it('reads claude auth status JSON', () => {
    const ready = claude.authProbe?.interpret({
      stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"enterprise"}',
      stderr: '',
      code: 0,
      timedOut: false,
    });
    expect(ready?.state).toBe('ready');
    expect(ready?.detail).toContain('claude.ai');
    // The account email is deliberately not echoed into the agent list.
    expect(ready?.detail).not.toContain('@');

    expect(
      claude.authProbe?.interpret({ stdout: '{"loggedIn":false}', stderr: '', code: 1, timedOut: false })?.state,
    ).toBe('signed-out');
  });

  /**
   * A CLI that changes its output format must degrade to `unknown`, never to
   * `ready` (which recreates the cryptic-first-session failure) and never to
   * `signed-out` (which would nag an operator authenticated by env var).
   */
  it('degrades to unknown when claude stops answering JSON', () => {
    for (const stdout of ['', 'Logged in as someone', 'not json at all']) {
      expect(claude.authProbe?.interpret({ stdout, stderr: '', code: 0, timedOut: false })?.state).toBe('unknown');
    }
    expect(claude.authProbe?.interpret({ stdout: '', stderr: '', code: null, timedOut: true })?.state).toBe('unknown');
  });

  /**
   * "not logged in" contains "logged in", so the negative has to be tested
   * first — the obvious `/logged in/` check alone reports a signed-out CLI as
   * ready.
   */
  it('does not read codex "not logged in" as logged in', () => {
    expect(
      codex.authProbe?.interpret({ stdout: 'Not logged in', stderr: '', code: 1, timedOut: false })?.state,
    ).toBe('signed-out');
    expect(
      codex.authProbe?.interpret({ stdout: 'Logged in using ChatGPT', stderr: '', code: 0, timedOut: false })?.state,
    ).toBe('ready');
    expect(codex.authProbe?.interpret({ stdout: 'huh?', stderr: '', code: 0, timedOut: false })?.state).toBe('unknown');
  });

  /**
   * PA-146: `agy` has no `auth`/`login` subcommand, so its probe runs
   * `agy models` (argv `['models']`, no shell). Tested with the recorded
   * signed-in and signed-out outputs from the real CLI, plus network/format
   * failures that must degrade to `unknown` rather than `signed-out` or `ready`.
   */
  it('interprets agy models for signed-in, signed-out, and unrecognised/network-error output (PA-146)', () => {
    expect(agy.authProbe?.args).toEqual(['models']);

    const ready = agy.authProbe?.interpret({
      stdout: 'Fetching available models...\nauto\tGemini Pro Next\ngemini-3.7-flash-high\tGemini 3.7 Flash (High)\n',
      stderr: '',
      code: 0,
      timedOut: false,
    });
    expect(ready).toEqual({ state: 'ready', detail: 'Signed in' });

    const signedOutStderr = agy.authProbe?.interpret({
      stdout: '',
      stderr: 'Error: Please sign in to view available models. Launch the CLI without arguments to sign in.',
      code: 1,
      timedOut: false,
    });
    expect(signedOutStderr?.state).toBe('signed-out');
    expect(signedOutStderr?.detail).toContain('Run `agy`');

    const signedOutStdout = agy.authProbe?.interpret({
      stdout: 'Error: Please sign in to view available models. Launch the CLI without arguments to sign in.',
      stderr: '',
      code: 1,
      timedOut: false,
    });
    expect(signedOutStdout?.state).toBe('signed-out');

    // Network failure, empty output, non-zero exit with model-like line, or
    // exit 0 with no model lines must all map to `unknown` with a detail.
    for (const sample of [
      { stdout: '', stderr: 'Error: fetch failed: ECONNREFUSED', code: 1, timedOut: false },
      { stdout: 'Fetching available models...\n', stderr: '', code: 0, timedOut: false },
      { stdout: 'unexpected format with no tab', stderr: '', code: 0, timedOut: false },
      { stdout: 'auto\tGemini Pro Next\n', stderr: 'partial error', code: 1, timedOut: false },
      { stdout: '', stderr: '', code: 0, timedOut: false },
      { stdout: '', stderr: '', code: null, timedOut: true },
    ]) {
      const res = agy.authProbe?.interpret(sample);
      expect(res?.state, JSON.stringify(sample)).toBe('unknown');
      expect(res?.detail && res.detail.length > 0, JSON.stringify(sample)).toBe(true);
    }
  });

  /**
   * PA-159: OpenCode v2 adds `opencode auth list --standalone --format json`,
   * answering a JSON array of integrations and their connections in-process
   * without requiring `opencode serve`. Tested with recorded v2 outputs for
   * signed-in (single and multiple integrations, plus connection-label
   * fallback), signed-out (`[]`, `No authenticated integrations`, and
   * empty-connections entries), and empty/malformed/error/timeout cases that
   * must degrade to `unknown`.
   */
  it('interprets opencode auth list JSON for signed-in, signed-out, empty, and malformed output (PA-159)', () => {
    expect(opencode.authProbe?.args).toEqual(['auth', 'list', '--standalone', '--format', 'json']);

    const readySingle = opencode.authProbe?.interpret({
      stdout: JSON.stringify([
        {
          id: 'opencode',
          name: 'OpenCode Console',
          connections: [{ type: 'credential', label: 'Default', method: 'oauth' }],
        },
      ]),
      stderr: '',
      code: 0,
      timedOut: false,
    });
    expect(readySingle).toEqual({ state: 'ready', detail: 'Signed in (OpenCode Console)' });

    const readyMultiple = opencode.authProbe?.interpret({
      stdout: JSON.stringify([
        {
          id: 'google',
          name: 'Google',
          connections: [{ type: 'env', name: 'GEMINI_API_KEY' }],
        },
        {
          id: 'opencode',
          name: 'OpenCode Console',
          connections: [{ type: 'credential', id: 'cred_1', label: 'OpenCode Console', method: 'key' }],
        },
      ]),
      stderr: '',
      code: 0,
      timedOut: false,
    });
    expect(readyMultiple).toEqual({ state: 'ready', detail: 'Signed in (Google, OpenCode Console)' });

    const readyConnectionFallback = opencode.authProbe?.interpret({
      stdout: JSON.stringify([{ connections: [{ type: 'credential', label: 'Default', method: 'oauth' }] }]),
      stderr: '',
      code: 0,
      timedOut: false,
    });
    expect(readyConnectionFallback).toEqual({ state: 'ready', detail: 'Signed in (Default)' });

    for (const sample of [
      { stdout: '[]\n', stderr: '', code: 0, timedOut: false },
      { stdout: 'No authenticated integrations\n', stderr: '', code: 0, timedOut: false },
      {
        stdout: JSON.stringify([{ id: 'opencode', name: 'OpenCode Console', connections: [] }]),
        stderr: '',
        code: 0,
        timedOut: false,
      },
    ]) {
      const res = opencode.authProbe?.interpret(sample);
      expect(res, JSON.stringify(sample)).toEqual({
        state: 'signed-out',
        detail: 'Not signed in. Run `opencode auth login` in a shell session on this host.',
      });
    }

    for (const sample of [
      { stdout: '', stderr: '', code: 0, timedOut: false },
      { stdout: '', stderr: '', code: null, timedOut: true },
      { stdout: '┌  Credentials\n│  opencode (oauth)\n└', stderr: '', code: 0, timedOut: false },
      { stdout: 'not json at all', stderr: '', code: 0, timedOut: false },
      { stdout: '{"loggedIn":true}', stderr: '', code: 0, timedOut: false },
      { stdout: '[123]', stderr: '', code: 0, timedOut: false },
      { stdout: '[{}]', stderr: '', code: 0, timedOut: false },
      { stdout: '[{"id":"opencode","connections":"invalid"}]', stderr: '', code: 0, timedOut: false },
      { stdout: '', stderr: 'Unknown argument: standalone', code: 1, timedOut: false },
      {
        stdout: JSON.stringify([
          { id: 'opencode', name: 'OpenCode Console', connections: [{ type: 'credential', label: 'Default' }] },
        ]),
        stderr: 'Error: failed to read credentials',
        code: 1,
        timedOut: false,
      },
    ]) {
      const res = opencode.authProbe?.interpret(sample);
      expect(res?.state, JSON.stringify(sample)).toBe('unknown');
      expect(res?.detail && res.detail.length > 0, JSON.stringify(sample)).toBe(true);
    }
  });

  /** The agents that genuinely cannot be asked declare no probe at all. */
  it('declares no probe for agents with no non-interactive way to answer', async () => {
    const { createPiAdapter } = await import('../src/agents/pi.js');
    expect(createPiAdapter('pi').authProbe).toBeUndefined();
  });

  /**
   * When PocketAgent runs as a `systemd --user` service on a Linux host with a
   * desktop/XRDP session (`gnome-keyring-daemon` on `/run/user/$UID/bus`),
   * `SSH_*` is unset in the daemon environment while an operator signing in
   * over SSH writes only to `~/.gemini/antigravity-cli/antigravity-oauth-token`.
   * Forcing `SSH_CONNECTION` on `agy` spawns keeps sessions, model probes,
   * auth probes, and usage polls on the file-based token store.
   */
  it('forces agy onto file-based token storage across buildCommand and probeAgentAuth', async () => {
    expect(agyFileTokenStorageEnv({})).toEqual({ SSH_CONNECTION: 'pocketagent' });
    expect(agyFileTokenStorageEnv({ SSH_CONNECTION: '10.0.0.1 12345 10.0.0.2 22' })).toEqual({
      SSH_CONNECTION: '10.0.0.1 12345 10.0.0.2 22',
    });
    expect(agy.buildCommand({ cwd: '/tmp', cols: 80, rows: 24 }).env?.SSH_CONNECTION).toBeTruthy();

    const dir = mkdtempSync(path.join(os.tmpdir(), 'pa-agy-probe-'));
    try {
      const fakeAgy = path.join(dir, 'agy');
      writeFileSync(
        fakeAgy,
        '#!/bin/sh\nif [ -n "$SSH_CONNECTION" ]; then\n  printf "auto\\tGemini Pro Next\\n"\n  exit 0\nfi\nprintf "Error: Please sign in to view available models.\\n" >&2\nexit 1\n',
      );
      chmodSync(fakeAgy, 0o755);
      const res = await probeAgentAuth(createAgyAdapter(fakeAgy));
      expect(res).toEqual({ state: 'ready', detail: 'Signed in' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('install routes', () => {
  let t: TestApp;
  let host: FakeHost;
  let runner: InstallRunner;
  let calls: { command: string; args: string[]; env: Record<string, string>; unsetEnv: string[]; cwd: string; script: string | null }[];
  let fetched: string[];
  let fetchScript: ScriptFetcher;
  let behaviour: (onOutput: (c: string) => void) => Promise<{
    code: number | null;
    timedOut: boolean;
    startError: string | null;
  }>;

  /** What a successful official claude install leaves behind. */
  const installClaude = (version = '2.1.290'): void => {
    host.exe(`.local/share/claude/versions/${version}`, `${version} (Claude Code)`);
    const link = path.join(host.home, '.local/bin/claude');
    if (existsSync(link)) unlinkSync(link);
    host.link('.local/bin/claude', `.local/share/claude/versions/${version}`);
  };

  beforeEach(async () => {
    host = fakeHost();
    // Post-install the version probe asks npm for the latest number; no test
    // may reach the real registry.
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
    calls = [];
    fetched = [];
    behaviour = async (onOutput) => {
      onOutput('installed\n');
      return { code: 0, timedOut: false, startError: null };
    };
    fetchScript = async (url) => {
      fetched.push(url);
      return { body: Buffer.from('#!/bin/sh\necho official installer\n'), finalUrl: url };
    };
    runner = async ({ command, args, env, unsetEnv, cwd, onOutput }) => {
      // The script file is deleted after the run, so capture it now.
      const script = args[0]?.endsWith('install.sh') ? readFileSync(args[0], 'utf8') : null;
      calls.push({ command, args, env, unsetEnv, cwd, script });
      return behaviour(onOutput);
    };
    t = await createTestApp(
      { POCKETAGENT_AGENT_INSTALL_PREFIX: path.join(host.home, '.npm-global') },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runner,
      undefined,
      undefined,
      (url) => fetchScript(url),
    );
  });

  afterEach(async () => {
    await t.context.agentInstall.settle();
    await t.cleanup();
    vi.unstubAllGlobals();
    host.restore();
  });

  const post = (payload: unknown, url = '/api/agents/install') =>
    t.app.inject({ method: 'POST', url, headers: authHeaders(t.cookie), payload });

  it('lists the catalog with its prefix', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/agents/installable',
      headers: authHeaders(t.cookie),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as InstallableAgentListResponse;
    expect(body.agents.map((a) => a.id).sort()).toEqual([...INSTALLABLE_AGENT_IDS].sort());
    expect(body.prefix).toBe(path.join(host.home, '.npm-global'));
  });

  it('requires authentication', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/agents/installable' });
    expect(res.statusCode).toBe(401);
  });

  /**
   * THE acceptance criterion: the browser never supplies an executable or
   * argv, so an arbitrary package name is refused. Asserting that nothing was
   * fetched or run is the part that matters most — a 400 that had already
   * spawned something would satisfy a status-only assertion.
   */
  it('rejects an arbitrary package name or URL and runs nothing', async () => {
    for (const id of ['@evil/pkg', 'left-pad', 'claude; rm -rf /', '../../etc/passwd', 'https://evil.example/x.sh', '']) {
      const res = await post({ id });
      expect(res.statusCode, `id=${id}`).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
    }
    for (const target of ['https://evil.example/x.sh', '9.9.9', '/bin/sh']) {
      const res = await post({ id: 'claude', target });
      expect(res.statusCode, `target=${target}`).toBe(400);
    }
    expect(calls).toEqual([]);
    expect(fetched).toEqual([]);
  });

  it('rejects a well-formed agent id that is not in the catalog', async () => {
    const res = await post({ id: 'shell' });
    expect(res.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it('rejects a body that smuggles a URL alongside a valid id', async () => {
    installClaude();
    const res = await post({ id: 'claude', scriptUrl: 'https://evil.example/x.sh', version: '9.9.9', packageName: 'evil' });
    expect(res.statusCode, res.body).toBe(200);
    await t.context.agentInstall.settle();
    expect(fetched).toEqual(['https://claude.ai/install.sh']);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).not.toContain('evil');
    expect(JSON.stringify(calls[0])).not.toContain('9.9.9');
  });

  /** A POST, so `app.ts`'s single Origin gate covers it. */
  it('refuses a cross-origin install', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/agents/install',
      headers: { cookie: t.cookie, origin: 'https://evil.example', host: '127.0.0.1:8787' },
      payload: { id: 'claude' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden_origin');
    expect(calls).toEqual([]);
  });

  /**
   * The official installer, as argv: `[interpreter, <downloaded file>]`, never
   * `bash -c` or a pipeline — and the file is exactly the bytes fetched from
   * the catalog's URL.
   */
  it('runs the official installer as a downloaded file, and records what ran', async () => {
    behaviour = async (onOutput) => {
      installClaude();
      onOutput('✅ Installation complete!\n');
      return { code: 0, timedOut: false, startError: null };
    };
    const res = await post({ id: 'claude' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    // Defeats nginx's default response buffering, which would otherwise hold
    // the whole stream until the install finished.
    expect(res.headers['x-accel-buffering']).toBe('no');

    const events = parseEvents(res.payload);
    const started = events[0];
    expect(started?.kind === 'install_started' && started.source).toBe('https://claude.ai/install.sh');
    expect(started?.kind === 'install_started' && started.action).toBe('install');
    expect(started?.kind === 'install_started' && started.attached).toBe(false);
    const finished = events.at(-1);
    expect(finished?.kind === 'install_finished' && finished.ok, JSON.stringify(finished)).toBe(true);

    const log = events.filter((e) => e.kind === 'install_log').map((e) => (e.kind === 'install_log' ? e.text : '')).join('');
    expect(log).toMatch(/Downloaded https:\/\/claude\.ai\/install\.sh \(\d+ bytes, sha256 [0-9a-f]{64}\)/);
    expect(log).toContain(`claude now resolves to ${path.join(host.home, '.local/bin/claude')}`);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe('bash');
    expect(call.args).toHaveLength(1);
    expect(call.args[0]).toMatch(/pocketagent-installer-.*\/install\.sh$/);
    expect(call.script).toBe('#!/bin/sh\necho official installer\n');
    // The temp copy does not outlive the run.
    expect(existsSync(call.args[0]!)).toBe(false);
  });

  /**
   * The installer must not run from the server's own cwd, must not see the
   * install prefix on PATH, and must not inherit an `NPM_CONFIG_PREFIX` that
   * would aim any `npm -g` it runs back at `~/.npm-global`.
   */
  it('gives the installer a neutral cwd, the official PATH and no npm prefix', async () => {
    await post({ id: 'pi' });
    await t.context.agentInstall.settle();
    const call = calls[0]!;
    expect(call.command).toBe('sh');
    expect(call.cwd).toBe(realpathSync(os.tmpdir()));
    expect(call.cwd).not.toBe(process.cwd());
    expect(call.env.PATH?.split(path.delimiter)[0]).toBe(path.join(host.home, '.local', 'bin'));
    expect(call.env.PATH).not.toContain(path.join(host.home, '.npm-global'));
    expect(call.unsetEnv).toEqual(expect.arrayContaining(['NPM_CONFIG_PREFIX', 'npm_config_prefix']));
  });

  it('runs codex non-interactively', async () => {
    await post({ id: 'codex' });
    await t.context.agentInstall.settle();
    expect(fetched).toEqual(['https://chatgpt.com/codex/install.sh']);
    expect(calls[0]?.command).toBe('sh');
    expect(calls[0]?.env.CODEX_NON_INTERACTIVE).toBe('1');
  });

  /**
   * PA-104's rule, enforced rather than logged: an installer that exits 0 but
   * leaves no official copy running is a failure, and the error names what
   * does run instead.
   */
  it('fails an install whose result is not the official copy that runs', async () => {
    behaviour = async () => {
      // "Succeeds", but what runs is a plain file in ~/.local/bin, not a link
      // into ~/.local/share/claude/versions.
      host.exe('.local/bin/claude');
      return { code: 0, timedOut: false, startError: null };
    };
    const res = await post({ id: 'claude' });
    const finished = parseEvents(res.payload).find((e) => e.kind === 'install_finished');
    expect(finished?.kind === 'install_finished' && finished.ok).toBe(false);
    expect(finished?.kind === 'install_finished' && finished.error).toMatch(/not the official install/);
    expect(finished?.kind === 'install_finished' && finished.error).toContain(path.join(host.home, '.local/bin/claude'));
  });

  it('fails an install that leaves nothing to run', async () => {
    const res = await post({ id: 'claude' });
    const finished = parseEvents(res.payload).find((e) => e.kind === 'install_finished');
    expect(finished?.kind === 'install_finished' && finished.ok).toBe(false);
    expect(finished?.kind === 'install_finished' && finished.error).toMatch(/not in any directory this server searches/);
  });

  /**
   * Acceptance criterion: upgrading a host that already has an official
   * install upgrades *that* copy — by its own update command, run on the
   * resolved path — and creates no second one. Nothing is downloaded.
   */
  it('updates the official copy in place with its own update command', async () => {
    installClaude('2.1.278');
    host.exe('.npm-global/bin/claude', '2.1.282');
    behaviour = async () => {
      installClaude('2.1.290');
      return { code: 0, timedOut: false, startError: null };
    };
    const res = await post({ id: 'claude', target: 'update' });
    const events = parseEvents(res.payload);
    const finished = events.find((e) => e.kind === 'install_finished');
    expect(finished?.kind === 'install_finished' && finished.ok, JSON.stringify(finished)).toBe(true);
    expect(fetched).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(path.join(host.home, '.local/bin/claude'));
    expect(calls[0]?.args).toEqual(['update']);
    // Nothing new landed in the prefix: the leftover copy is exactly as it was.
    expect(readFileSync(path.join(host.home, '.npm-global/bin/claude'), 'utf8')).toContain('2.1.282');
  });

  /** PA-90's `latest` means "update" now, never `npm install pkg@latest`. */
  it('treats the old latest target as an in-place update', async () => {
    installClaude('2.1.278');
    await post({ id: 'claude', target: 'latest' });
    await t.context.agentInstall.settle();
    expect(calls[0]?.command).toBe(path.join(host.home, '.local/bin/claude'));
    expect(calls[0]?.args).toEqual(['update']);
    expect(calls.some((c) => c.command === 'npm')).toBe(false);
  });

  /** Updating a stray copy would leave the official one stale, so with none, update installs one. */
  it('installs officially when asked to update an agent with no official copy', async () => {
    host.exe('.npm-global/bin/claude', '2.1.282');
    await post({ id: 'claude', target: 'update' });
    await t.context.agentInstall.settle();
    expect(fetched).toEqual(['https://claude.ai/install.sh']);
    expect(calls[0]?.command).toBe('bash');
  });

  it('updates codex by re-running its installer, which updates in place', async () => {
    host.link('.local/bin/codex', '.codex/packages/standalone/current/bin/codex');
    host.exe('.codex/packages/standalone/current/bin/codex', '0.155.1');
    await post({ id: 'codex', target: 'update' });
    await t.context.agentInstall.settle();
    expect(fetched).toEqual(['https://chatgpt.com/codex/install.sh']);
    expect(calls[0]?.command).toBe('sh');
  });

  it('refuses a script that is not HTTPS end to end or is not a script', async () => {
    fetchScript = async (url) => ({ body: Buffer.from('#!/bin/sh\n'), finalUrl: url.replace('https:', 'http:') });
    let res = await post({ id: 'claude' });
    let finished = parseEvents(res.payload).find((e) => e.kind === 'install_finished');
    expect(finished?.kind === 'install_finished' && finished.error).toMatch(/non-HTTPS/);

    fetchScript = async (url) => ({ body: Buffer.from('<html>blocked</html>'), finalUrl: url });
    res = await post({ id: 'claude' });
    finished = parseEvents(res.payload).find((e) => e.kind === 'install_finished');
    expect(finished?.kind === 'install_finished' && finished.error).toMatch(/not a shell script/);

    fetchScript = async () => {
      throw new Error('getaddrinfo ENOTFOUND claude.ai');
    };
    res = await post({ id: 'claude' });
    finished = parseEvents(res.payload).find((e) => e.kind === 'install_finished');
    expect(finished?.kind === 'install_finished' && finished.error).toMatch(/ENOTFOUND/);
    expect(calls).toEqual([]);
  });

  /**
   * Acceptance criterion: the real error, not a generic failure — and it has
   * to outlive the stream, or it only holds while the operator is watching.
   */
  it("surfaces the installer's own error in the stream and persists the failure", async () => {
    behaviour = async (onOutput) => {
      onOutput('Managed install refused to replace Pi at /x/pi. Uninstall it first.\n');
      return { code: 1, timedOut: false, startError: null };
    };
    const res = await post({ id: 'pi' });
    const events = parseEvents(res.payload);
    const log = events.filter((e) => e.kind === 'install_log').map((e) => (e.kind === 'install_log' ? e.text : '')).join('');
    expect(log).toContain('Uninstall it first');
    const finished = events.find((e) => e.kind === 'install_finished');
    expect(finished?.kind === 'install_finished' && finished.ok).toBe(false);
    expect(finished?.kind === 'install_finished' && finished.error).toMatch(/exited with code 1/);

    const agents = await t.app.inject({ method: 'GET', url: '/api/agents', headers: authHeaders(t.cookie) });
    const row = (agents.json().agents as AgentInfo[]).find((a) => a.id === 'pi');
    expect(row?.lastInstallOk).toBe(false);
    expect(row?.lastInstallError).toMatch(/exited with code 1/);
  });

  /**
   * test01: a fresh volume inherited a root-owned ~/.local from the image, and
   * `claude update` exited 1 with its reason only in a closed dialog's log.
   * Now the job is refused before anything runs, the refusal names the
   * directory and the chown, and it is persisted for the Settings row.
   */
  it.skipIf(process.getuid?.() === 0)('refuses to start when the official location is not writable, naming the fix', async () => {
    const local = path.join(host.home, '.local');
    mkdirSync(path.join(local, 'share'), { recursive: true });
    chmodSync(local, 0o555);
    try {
      const res = await post({ id: 'claude', target: 'update' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('home_not_writable');
      expect(res.json().error.message).toContain(local);
      expect(res.json().error.message).toMatch(/chown -R \d+:\d+ /);
      expect(calls).toEqual([]);
      expect(fetched).toEqual([]);
      const agents = await t.app.inject({ method: 'GET', url: '/api/agents', headers: authHeaders(t.cookie) });
      const row = (agents.json().agents as AgentInfo[]).find((a) => a.id === 'claude');
      expect(row?.lastInstallOk).toBe(false);
      expect(row?.lastInstallError).toContain(local);
    } finally {
      chmodSync(local, 0o755);
    }
  });

  /** The persisted error carries the command's own last words, not "see the log above". */
  it('keeps the tail of the output in the persisted failure', async () => {
    behaviour = async (onOutput) => {
      onOutput('\x1b[31mCurrent version: 2.1.274\x1b[0m\n');
      onOutput('Error: EACCES: permission denied, mkdir /home/pocketagent/.local/bin\n');
      return { code: 1, timedOut: false, startError: null };
    };
    installClaude('2.1.274');
    const res = await post({ id: 'claude', target: 'update' });
    const finished = parseEvents(res.payload).find((e) => e.kind === 'install_finished');
    expect(finished?.kind === 'install_finished' && finished.error).toMatch(
      /exited with code 1\..*Last output: Current version: 2\.1\.274 \/ Error: EACCES: permission denied, mkdir \/home\/pocketagent\/\.local\/bin$/,
    );
    const agents = await t.app.inject({ method: 'GET', url: '/api/agents', headers: authHeaders(t.cookie) });
    const row = (agents.json().agents as AgentInfo[]).find((a) => a.id === 'claude');
    expect(row?.lastInstallError).toContain('EACCES');
  });

  it('reports a failure when the interpreter cannot be started at all', async () => {
    behaviour = async () => ({ code: null, timedOut: false, startError: 'spawn bash ENOENT' });
    const res = await post({ id: 'claude' });
    const finished = parseEvents(res.payload).find((e) => e.kind === 'install_finished');
    expect(finished?.kind === 'install_finished' && finished.error).toMatch(/Could not run bash/);
    expect(finished?.kind === 'install_finished' && finished.error).toMatch(/ENOENT/);
  });

  /**
   * The leftover pre-PA-104 Settings copy can be removed — explicitly, only
   * from the install prefix, and only with `npm uninstall --prefix` aimed at
   * that prefix.
   */
  it('removes a leftover install-prefix copy on request', async () => {
    host.exe('.npm-global/bin/codex', '0.157.0');
    behaviour = async () => {
      unlinkSync(path.join(host.home, '.npm-global/bin/codex'));
      return { code: 0, timedOut: false, startError: null };
    };
    const res = await post({ id: 'codex', target: 'remove-prefix-copy' });
    const finished = parseEvents(res.payload).find((e) => e.kind === 'install_finished');
    expect(finished?.kind === 'install_finished' && finished.ok, JSON.stringify(finished)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('npm');
    expect(calls[0]?.args).toEqual([
      'uninstall',
      '--global',
      `--prefix=${path.join(host.home, '.npm-global')}`,
      '--no-fund',
      '--no-audit',
      '@openai/codex',
    ]);
    expect(fetched).toEqual([]);
  });

  it('fails a removal that left the copy behind', async () => {
    host.exe('.npm-global/bin/codex');
    const res = await post({ id: 'codex', target: 'remove-prefix-copy' });
    const finished = parseEvents(res.payload).find((e) => e.kind === 'install_finished');
    expect(finished?.kind === 'install_finished' && finished.error).toMatch(/still there/);
  });

  /** Only the prefix copy — a system copy elsewhere is report-only, never removed. */
  it('refuses a removal when there is no install-prefix copy', async () => {
    host.exe(path.join(host.pathDir, 'codex'), '0.147.0');
    const res = await post({ id: 'codex', target: 'remove-prefix-copy' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('nothing_to_remove');
    expect(calls).toEqual([]);
  });

  it('refuses a removal for an agent that never had an npm package', async () => {
    host.exe('.npm-global/bin/agy');
    const res = await post({ id: 'agy', target: 'remove-prefix-copy' });
    expect(res.statusCode).toBe(409);
    expect(calls).toEqual([]);
  });

  /**
   * A second install of a different agent is refused rather than queued: these
   * are large downloads and `RunQueue` is the wrong tool (it keys on working
   * trees, and an install has none).
   */
  it('refuses a concurrent install of a different agent', async () => {
    let release: () => void = () => undefined;
    behaviour = async () =>
      new Promise((resolve) => {
        release = () => resolve({ code: 0, timedOut: false, startError: null });
      });
    const first = post({ id: 'pi' });
    // Let the handler reach the runner before racing it.
    await new Promise((r) => setTimeout(r, 50));
    const second = await post({ id: 'codex' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('busy');
    release();
    await first;
  });

  /**
   * Re-POSTing the same id while it runs attaches to the job instead of
   * starting a second install — which is what makes navigating away and back
   * safe, and is the whole reason the job outlives the stream.
   */
  it('attaches to an install already in flight rather than starting a second', async () => {
    let release: () => void = () => undefined;
    behaviour = async (onOutput) => {
      onOutput('reticulating splines\n');
      return new Promise((resolve) => {
        release = () => resolve({ code: 0, timedOut: false, startError: null });
      });
    };
    const first = post({ id: 'pi' });
    await new Promise((r) => setTimeout(r, 50));
    const second = post({ id: 'pi' });
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [, secondRes] = await Promise.all([first, second]);

    // One invocation of the installer, two streams.
    expect(calls).toHaveLength(1);
    const events = parseEvents(secondRes.payload);
    const started = events[0];
    expect(started?.kind === 'install_started' && started.attached).toBe(true);
    // The attached stream replays the log it missed rather than starting blank.
    expect(events.some((e) => e.kind === 'install_log' && e.text.includes('reticulating'))).toBe(true);
  });

  /**
   * The npm prefix setting gates only npm-method installs; an official
   * installer never writes there, so a prefix the server would not search is
   * no reason to refuse one.
   */
  it('installs officially whatever the npm prefix is set to', async () => {
    const other = await createTestApp(
      { POCKETAGENT_AGENT_INSTALL_PREFIX: '/tmp/pocketagent-nowhere' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runner,
      undefined,
      undefined,
      (url) => fetchScript(url),
    );
    try {
      const res = await other.app.inject({
        method: 'POST',
        url: '/api/agents/install',
        headers: authHeaders(other.cookie),
        payload: { id: 'pi' },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(calls).toHaveLength(1);
    } finally {
      await other.context.agentInstall.settle();
      await other.cleanup();
    }
  });

  /**
   * Acceptance criterion: a leftover `~/.npm-global` copy is surfaced, and
   * the path the server runs is on the list so an operator can compare it
   * with `bash -lc 'command -v <agent>'`.
   */
  it('surfaces the running path and leftover copies on GET /api/agents', async () => {
    installClaude('2.1.278');
    host.exe('.npm-global/bin/claude', '2.1.282');
    const res = await t.app.inject({ method: 'GET', url: '/api/agents', headers: authHeaders(t.cookie) });
    const claude = (res.json().agents as AgentInfo[]).find((a) => a.id === 'claude');
    expect(claude?.available).toBe(true);
    expect(claude?.resolvedPath).toBe(path.join(host.home, '.local/bin/claude'));
    expect(claude?.officialInstall).toBe(true);
    expect(claude?.otherCopies).toEqual([
      {
        path: path.join(host.home, '.npm-global/bin/claude'),
        realPath: path.join(host.home, '.npm-global/bin/claude'),
        kind: 'install-prefix',
      },
    ]);
  });
});

describe('agent setup state over HTTP', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.cleanup();
  });

  it('reports a setup state and a bin-override flag for every agent', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/agents', headers: authHeaders(t.cookie) });
    const agents = res.json().agents as {
      id: string;
      available: boolean;
      setupState: string;
      binOverridden: boolean;
    }[];
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect(['not-installed', 'signed-out', 'ready', 'unknown']).toContain(agent.setupState);
      if (!agent.available) expect(agent.setupState).toBe('not-installed');
      expect(typeof agent.binOverridden).toBe('boolean');
    }
  });

  /**
   * An absolute path takes `resolveExecutable`'s early return, so the install
   * prefix is never consulted for that agent and an install would land
   * somewhere the server never looks. The browser cannot work this out — it
   * never sees `claudeBin` — so the server has to say it.
   */
  it('flags an agent whose binary is pinned to an absolute path', async () => {
    const ws = makeWorkspace();
    const db = openDatabase(':memory:');
    const { app, context } = await buildApp({
      config: makeConfig({
        POCKETAGENT_WORKSPACE_ROOTS: ws.root,
        POCKETAGENT_CLAUDE_BIN: '/opt/custom/claude',
      }),
      db,
      plannerWorkspacesRoot: path.join(ws.root, 'pw'),
      plannerSkillsRoot: path.join(ws.root, 'ps'),
      attachmentStagingDir: path.join(ws.root, 'as'),
      legacyProviderEnv: {},
      serveStatic: false,
    });
    try {
      await app.ready();
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: TEST_TOKEN } });
      const sc = login.cookies[0];
      const cookie = sc ? `${sc.name}=${sc.value}` : '';
      const res = await app.inject({ method: 'GET', url: '/api/agents', headers: { cookie } });
      const agents = res.json().agents as { id: string; binOverridden: boolean }[];
      expect(agents.find((a) => a.id === 'claude')?.binOverridden).toBe(true);
      expect(agents.find((a) => a.id === 'codex')?.binOverridden).toBe(false);
      expect(context.config.claudeBin).toBe('/opt/custom/claude');
    } finally {
      await app.close();
      ws.cleanup();
    }
  });

  it('reports ready for a signed-in agy and signed-out for a signed-out one after Refresh (PA-146)', async () => {
    const host = fakeHost();
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
    try {
      const agyBin = path.join(host.home, '.local/bin/agy');
      mkdirSync(path.dirname(agyBin), { recursive: true });

      // Signed-in agy: `agy models` exits 0 with a tab-separated model line.
      writeFileSync(
        agyBin,
        '#!/bin/sh\nif [ "$1" = "models" ]; then\n  printf "Fetching available models...\\nauto\\tGemini Pro Next\\n"\n  exit 0\nfi\necho "1.2.2"\n',
        { mode: 0o755 },
      );

      let res = await t.app.inject({
        method: 'POST',
        url: '/api/agents/refresh',
        headers: authHeaders(t.cookie),
      });
      expect(res.statusCode).toBe(200);
      let agyRow = (res.json().agents as AgentInfo[]).find((a) => a.id === 'agy');
      expect(agyRow?.setupState).toBe('ready');

      // Signed-out agy: `agy models` exits 1 with the "Please sign in" message.
      writeFileSync(
        agyBin,
        '#!/bin/sh\nif [ "$1" = "models" ]; then\n  echo "Error: Please sign in to view available models. Launch the CLI without arguments to sign in." >&2\n  exit 1\nfi\necho "1.2.2"\n',
        { mode: 0o755 },
      );

      res = await t.app.inject({
        method: 'POST',
        url: '/api/agents/refresh',
        headers: authHeaders(t.cookie),
      });
      expect(res.statusCode).toBe(200);
      agyRow = (res.json().agents as AgentInfo[]).find((a) => a.id === 'agy');
      expect(agyRow?.setupState).toBe('signed-out');
      expect(agyRow?.setupDetail).toContain('Run `agy`');
    } finally {
      vi.unstubAllGlobals();
      host.restore();
    }
  });

  it('reports ready for a signed-in opencode and signed-out for a signed-out one after Refresh (PA-159)', async () => {
    const host = fakeHost();
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
    try {
      const opencodeBin = path.join(host.home, '.opencode/bin/opencode');
      mkdirSync(path.dirname(opencodeBin), { recursive: true });

      // Signed-in opencode: `opencode auth list --standalone --format json` exits 0 with JSON integrations.
      writeFileSync(
        opencodeBin,
        '#!/bin/sh\nif [ "$1" = "auth" ] && [ "$2" = "list" ] && [ "$3" = "--standalone" ] && [ "$4" = "--format" ] && [ "$5" = "json" ]; then\n  printf \'[{"id":"opencode","name":"OpenCode Console","connections":[{"type":"credential","label":"Default","method":"oauth"}]}]\\n\'\n  exit 0\nfi\necho "2.0.2"\n',
        { mode: 0o755 },
      );

      let res = await t.app.inject({
        method: 'POST',
        url: '/api/agents/refresh',
        headers: authHeaders(t.cookie),
      });
      expect(res.statusCode).toBe(200);
      let opencodeRow = (res.json().agents as AgentInfo[]).find((a) => a.id === 'opencode');
      expect(opencodeRow?.setupState).toBe('ready');
      expect(opencodeRow?.setupDetail).toBe('Signed in (OpenCode Console)');

      // Signed-out opencode: `opencode auth list --standalone --format json` exits 0 with `[]`.
      writeFileSync(
        opencodeBin,
        '#!/bin/sh\nif [ "$1" = "auth" ] && [ "$2" = "list" ]; then\n  printf "[]\\n"\n  exit 0\nfi\necho "2.0.2"\n',
        { mode: 0o755 },
      );

      res = await t.app.inject({
        method: 'POST',
        url: '/api/agents/refresh',
        headers: authHeaders(t.cookie),
      });
      expect(res.statusCode).toBe(200);
      opencodeRow = (res.json().agents as AgentInfo[]).find((a) => a.id === 'opencode');
      expect(opencodeRow?.setupState).toBe('signed-out');
      expect(opencodeRow?.setupDetail).toContain('Run `opencode auth login`');
    } finally {
      vi.unstubAllGlobals();
      host.restore();
    }
  });
});

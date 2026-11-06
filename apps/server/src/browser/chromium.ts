import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildChildEnv } from '../sessions/env.js';

/**
 * PA-178: finding and launching the shared Chromium.
 *
 * The server launches the binary itself rather than through `playwright-core`.
 * The `all` image installs the Chromium revision `@playwright/cli`'s *bundled*
 * playwright-core expects; a second playwright-core in this package would look
 * for its own revision, and the two pins drifting would break the feature with
 * no code change here. Raw CDP over the `ws` package this server already
 * depends on needs no revision at all.
 *
 * Every argument is built here. Nothing a request carries reaches the argv —
 * no executable, no flag, no URL — and the CDP endpoint binds `127.0.0.1`.
 */

/**
 * Where to look: `$PLAYWRIGHT_BROWSERS_PATH` (the image sets `/opt/pw-browsers`)
 * else Playwright's per-user cache. Newest revision first. A closed list of
 * layouts, never a search of the filesystem.
 */
export function findChromiumExecutable(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  const roots = [
    env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0' ? env.PLAYWRIGHT_BROWSERS_PATH : null,
    platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
      : path.join(os.homedir(), '.cache', 'ms-playwright'),
  ].filter((r): r is string => r !== null);
  const layouts =
    platform === 'darwin'
      ? [
          'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        ]
      : ['chrome-linux64/chrome', 'chrome-linux/chrome'];
  for (const root of roots) {
    let revisions: string[];
    try {
      revisions = fs
        .readdirSync(root)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
    } catch {
      continue;
    }
    for (const rev of revisions) {
      for (const layout of layouts) {
        const candidate = path.join(root, rev, layout);
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        } catch {
          // next layout
        }
      }
    }
  }
  return null;
}

/** The major version, from `chrome --version` ("Google Chrome for Testing 155.0.8059.12"). */
export function chromiumMajorVersion(executable: string): string {
  try {
    const out = execFileSync(executable, ['--version'], { timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return out.match(/(\d+)\.\d+\.\d+/)?.[1] ?? '0';
  } catch {
    return '0';
  }
}

/**
 * The user agent the browser presents. Found by the PA-178 spike: headless
 * Chromium says `HeadlessChrome` in both the UA and `Sec-CH-UA`, and Google's
 * sign-in refuses it at the email step ("This browser or app may not be
 * secure"). It is a launch flag rather than a per-session
 * `Emulation.setUserAgentOverride` so the *agent's* CDP sessions get it too.
 */
export function userAgentFor(major: string, platform = process.platform): string {
  const os =
    platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export interface ChromiumArgsInput {
  profileDir: string;
  sandbox: boolean;
  majorVersion: string;
  platform?: NodeJS.Platform;
}

/**
 * The whole argv, pure so a test can pin it. Each flag below was needed by a
 * measured case in the spike; none is decoration.
 */
export function buildChromiumArgs(input: ChromiumArgsInput): string[] {
  return [
    '--headless=new',
    // Loopback only, port chosen by the kernel and read back from stderr.
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${input.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // No keyring in a container or a service; without it Chromium blocks on
    // an unlock prompt nobody can see.
    '--password-store=basic',
    '--disable-dev-shm-usage',
    // `navigator.webdriver` is true under `--remote-debugging-port` even with
    // no `--enable-automation`; Google's sign-in refused it until this and the
    // user agent below were both set (either alone was still refused).
    '--disable-blink-features=AutomationControlled',
    `--user-agent=${userAgentFor(input.majorVersion, input.platform)}`,
    ...(input.sandbox ? [] : ['--no-sandbox']),
    'about:blank',
  ];
}

export interface LaunchedChromium {
  child: ChildProcess;
  pid: number;
  /** `ws://127.0.0.1:<port>/devtools/browser/<uuid>` */
  browserWsUrl: string;
  /** `http://127.0.0.1:<port>` — what `playwright-cli attach --cdp=` takes. */
  cdpUrl: string;
}

const DEVTOOLS_LINE = /DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/[A-Za-z0-9-]+)/;

/**
 * Spawn Chromium and wait for its DevTools line. stderr is read only for that
 * line and kept as a short tail for a failure message; it is never logged,
 * because a browser's own diagnostics can name the pages it visited.
 */
export function launchChromium(
  executable: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<LaunchedChromium> {
  const cwd = opts.cwd ?? os.tmpdir();
  const child = spawn(executable, args, {
    cwd,
    env: buildChildEnv({ cwd }),
    stdio: ['ignore', 'ignore', 'pipe'],
    // Its own process group, so stopping it takes its renderers with it.
    detached: true,
  });
  return new Promise((resolve, reject) => {
    let tail = '';
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error('Chromium did not start within the time limit.'));
    }, opts.timeoutMs ?? 30_000);
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup(child, 'SIGKILL');
      reject(err);
    };
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (settled) return;
      tail = (tail + chunk).slice(-4000);
      const match = tail.match(DEVTOOLS_LINE);
      if (match && child.pid !== undefined) {
        settled = true;
        clearTimeout(timer);
        // Keep draining so a full pipe can never block the browser.
        child.stderr?.on('data', () => undefined);
        resolve({ child, pid: child.pid, browserWsUrl: match[1]!, cdpUrl: `http://127.0.0.1:${match[2]}` });
      }
    });
    child.once('error', (err) => fail(err));
    child.once('exit', (code, signal) => {
      const reason = /No usable sandbox/.test(tail) ? 'no usable sandbox' : `exited (${code ?? signal})`;
      fail(new Error(`Chromium ${reason} before it was ready.`));
    });
  });
}

/** Signal the whole process group the browser leads; never a pattern match. */
export function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  // `-0` would signal *this* process's own group, and `-1` every process we
  // may signal — never a browser's.
  if (child.pid === undefined || child.pid <= 1) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Whether the renderer sandbox works here. In a container without
 * unprivileged user namespaces Chromium aborts with "No usable sandbox!"; the
 * spike reproduced it on the `all` image. Probed once with a throwaway
 * profile, so a failure costs one short-lived process.
 */
export async function probeSandbox(executable: string, majorVersion: string): Promise<boolean> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-browser-probe-'));
  try {
    const launched = await launchChromium(
      executable,
      buildChromiumArgs({ profileDir: dir, sandbox: true, majorVersion }),
      { timeoutMs: 15_000 },
    );
    killGroup(launched.child, 'SIGKILL');
    return true;
  } catch {
    return false;
  } finally {
    // The killed browser may still be releasing files for a moment.
    setTimeout(() => fs.rm(dir, { recursive: true, force: true }, () => undefined), 2000).unref();
  }
}

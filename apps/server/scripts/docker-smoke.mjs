#!/usr/bin/env node
/**
 * PA-64's acceptance criteria, as a runnable check against a real container.
 *
 * The unit suite cannot cover any of this for the same reason it cannot cover
 * xterm rendering or a real tmux server: the thing under test is an image, a
 * uid mapping and a set of mounts. So this builds the thin image, runs it with
 * the documented volumes, and asserts the three criteria from the ticket —
 *
 *   1. a working UI, a session that runs, and a container restart that leaves
 *      the database, transcripts and installed agents intact
 *   2. files an agent writes inside a mounted repo are owned by the host user
 *   3. the documented extension example builds and starts
 *
 * plus the two contracts that are easy to break invisibly: that a *login*
 * shell still has the agent prefix on PATH (Debian's /etc/profile overwrites
 * PATH, and `exec_command` runs `$SHELL -lc`), and that the master token is
 * not baked into an image layer.
 *
 *   pnpm demo:docker
 *
 * Everything it creates is under one temp directory and one container name,
 * both removed on exit. It never touches the real database — the container
 * gets its own data root, which is what POCKETAGENT_DATA_DIR is for (PA-62).
 *
 * It also carries PA-65's release criteria, because they are the same build:
 * that the version stamped at build time is what `/health` reports and what
 * the *web bundle* carries, and that neither is ever `unknown`. Those two
 * halves are stamped by different mechanisms — an `ENV` the server reads at
 * boot, and a Vite `define` frozen into the JS — so one can regress while the
 * other still looks right.
 *
 * Environment:
 *   PA_SMOKE_PORT=18787   host port to publish on
 *   PA_SMOKE_KEEP=1       leave the container and temp dirs behind to poke at
 *   PA_SMOKE_SKIP_BUILD=1 reuse the existing :latest rather than rebuilding
 *   PA_SMOKE_VERSION      the semver to stamp (default 9.9.9-smoke)
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@pocketagent/protocol';

const REPO = path.resolve(new URL('../../..', import.meta.url).pathname);
const IMAGE = process.env.PA_IMAGE ?? 'registry.shifamily.com/homestack/pocketagent-server';
const CONTAINER = 'pocketagent-smoke';
const EXTEND_IMAGE = 'pocketagent-smoke-extended';
const PORT = Number(process.env.PA_SMOKE_PORT ?? 18787);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = randomBytes(32).toString('base64url');
const HOST_UID = process.getuid();
const HOST_GID = process.getgid();

let step = 0;
let failures = 0;
const ok = (label, detail = '') => console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail = '') => {
  failures++;
  console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
};
const check = (cond, label, detail) => (cond ? ok(label, detail) : bad(label, detail));
const heading = (title) => console.log(`\n[${++step}] ${title}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a command, throwing with both streams attached when it fails. */
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} exited ${res.status}\n${res.stdout ?? ''}\n${res.stderr ?? ''}`,
    );
  }
  return (res.stdout ?? '').trim();
}

/** Same, but a non-zero exit is an expected outcome rather than a crash. */
function tryRun(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    status: res.status,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  };
}

/**
 * Run a script inside the container *as the mapped user*.
 *
 * `--user` is not optional here: `docker exec` defaults to the image's user,
 * which is root, because the image deliberately has no USER instruction (the
 * entrypoint needs root to remap the uid before gosu drops it). An exec
 * without it writes root-owned files into the mounted $HOME — which is exactly
 * the trap an operator hits running `docker compose exec pocketagent claude`
 * to log the CLI in, so the README documents the same flag.
 *
 * `-l` makes it a login shell on purpose: that is how planner/tools.ts runs
 * exec_command, and it is the case where Debian's /etc/profile resets PATH.
 */
const inContainer = (script) =>
  tryRun('docker', ['exec', '--user', `${HOST_UID}:${HOST_GID}`, CONTAINER, 'sh', '-lc', script]);

// ---------------------------------------------------------------------------
// Scratch state. A throwaway data root, a throwaway HOME, and a real git repo
// standing in for one of the operator's checkouts.
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-docker-smoke-'));
const dataDir = path.join(tmp, 'data');
const homeDir = path.join(tmp, 'home');
// Mounted at the same absolute path inside the container, which is the rule
// the volume contract turns on; a temp dir is already identical on both sides.
const workspace = path.join(tmp, 'workspace');

function cleanup() {
  if (process.env.PA_SMOKE_KEEP === '1') {
    console.log(`\n(PA_SMOKE_KEEP=1 — left ${CONTAINER} running and ${tmp} in place)`);
    return;
  }
  tryRun('docker', ['rm', '-f', CONTAINER]);
  tryRun('docker', ['image', 'rm', '-f', EXTEND_IMAGE]);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // A failed run can leave root-owned paths behind (anything created by a
    // `docker exec` that forgot --user, or by the server before a remap).
    // Only root can remove those, and the image is already here.
    tryRun('docker', [
      'run', '--rm',
      '--volume', `${path.dirname(tmp)}:/scratch`,
      '--entrypoint', 'rm',
      `${IMAGE}:latest`,
      '-rf', `/scratch/${path.basename(tmp)}`,
    ]);
  }
}
process.on('exit', cleanup);

console.log('PocketAgent container smoke test\n' + '='.repeat(60));
console.log(`  image      ${IMAGE}:latest`);
console.log(`  host uid   ${HOST_UID}:${HOST_GID}`);
console.log(`  scratch    ${tmp}`);

heading('Build the thin image');
// A deliberately fake *release-shaped* version (PA-65), so the whole
// tag -> stamp -> /health -> web bundle chain is exercised rather than just
// "something was stamped". It is a prerelease of a version that will never
// exist, so a local image can never be mistaken for a published release.
const STAMP = process.env.PA_SMOKE_VERSION ?? '9.9.9-smoke';
if (process.env.PA_SMOKE_SKIP_BUILD === '1') {
  ok('skipped (PA_SMOKE_SKIP_BUILD=1)');
} else {
  run('docker/build.sh', [], {
    cwd: REPO,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, PA_VERSION: STAMP },
  });
  ok('docker/build.sh', `stamped ${STAMP}`);
}
{
  const size = run('docker', ['image', 'inspect', '-f', '{{.Size}}', `${IMAGE}:latest`]);
  ok('image present', `${(Number(size) / 1e9).toFixed(2)} GB`);
}

// What this image actually claims to be. Read back from the image rather than
// assumed from STAMP, so the skip-build path stays honest: it asserts the
// image's own stamp reaches both halves, whatever that stamp happens to be.
const imageStamp = (() => {
  const env = JSON.parse(run('docker', ['image', 'inspect', '-f', '{{json .Config.Env}}', `${IMAGE}:latest`]));
  const entry = env.find((e) => e.startsWith('POCKETAGENT_BUILD_VERSION='));
  return entry === undefined ? '' : entry.slice('POCKETAGENT_BUILD_VERSION='.length);
})();

heading('The build version is stamped into the image, and is tagged under it');
{
  check(imageStamp !== '' && imageStamp !== '0.0.0-dev', 'POCKETAGENT_BUILD_VERSION set', imageStamp);
  if (process.env.PA_SMOKE_SKIP_BUILD !== '1') {
    check(imageStamp === STAMP, 'the stamp is the version we asked for', imageStamp);
    // The image tag and the stamped version are one identity, which is the
    // whole point of PA-65: `:1.2.3` must not be able to report `1.2.2`.
    const tagged = tryRun('docker', ['image', 'inspect', '-f', '{{.Id}}', `${IMAGE}:${STAMP}`]);
    check(tagged.status === 0, `tagged :${STAMP} as well as :latest`);
  }
}

heading('The master token is not in any image layer');
{
  // The token only ever arrives as container environment. A `.dockerignore`
  // regression that let `.env` into the context would show up here, in
  // `docker history`, long before anyone thought to look for it.
  const history = run('docker', ['history', '--no-trunc', '--format', '{{.CreatedBy}}', `${IMAGE}:latest`]);
  const envFile = path.join(REPO, '.env');
  const realToken = fs.existsSync(envFile)
    ? (fs.readFileSync(envFile, 'utf8').match(/^POCKETAGENT_AUTH_TOKEN=(.+)$/m)?.[1] ?? '').trim()
    : '';
  check(!history.includes('POCKETAGENT_AUTH_TOKEN='), 'no token assignment in image history');
  check(
    realToken === '' || !history.includes(realToken),
    'the repo .env token does not appear in any layer',
  );
  const leaked = tryRun('docker', ['run', '--rm', '--entrypoint', 'ls', `${IMAGE}:latest`, '/app/.env']);
  check(leaked.status !== 0, '/app/.env does not exist in the image');
}

heading('Prepare the documented volumes');
{
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  // A real repo, so `git status` inside the mount is a genuine test of the
  // dubious-ownership failure mode rather than a simulation of it.
  run('git', ['init', '--quiet', '--initial-branch=main'], { cwd: workspace });
  run('git', ['config', 'user.email', 'smoke@example.invalid'], { cwd: workspace });
  run('git', ['config', 'user.name', 'Smoke Test'], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, 'README.md'), '# smoke\n');
  run('git', ['add', '-A'], { cwd: workspace });
  run('git', ['commit', '--quiet', '-m', 'initial'], { cwd: workspace });
  ok('data root, HOME and a git workspace created', workspace);
}

heading('Start the container');
{
  run('docker', [
    'run', '--detach',
    '--name', CONTAINER,
    '--publish', `127.0.0.1:${PORT}:8787`,
    '--env', `POCKETAGENT_AUTH_TOKEN=${TOKEN}`,
    '--env', `POCKETAGENT_WORKSPACE_ROOTS=${workspace}`,
    '--env', 'POCKETAGENT_COOKIE_SECURE=false',
    '--env', `PUID=${HOST_UID}`,
    '--env', `PGID=${HOST_GID}`,
    '--volume', `${dataDir}:/data`,
    '--volume', `${homeDir}:/home/pocketagent`,
    '--volume', `${workspace}:${workspace}`,
    `${IMAGE}:latest`,
  ]);
  ok('docker run', `port ${PORT}`);
}

async function waitForHealth(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return await res.json();
    } catch {
      // not up yet
    }
    if (tryRun('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER]).stdout !== 'true') {
      const logs = tryRun('docker', ['logs', CONTAINER]);
      throw new Error(`container exited\n${logs.stdout}\n${logs.stderr}`);
    }
    await sleep(500);
  }
  return null;
}

heading('It answers /health, with a real version');
let health;
{
  health = await waitForHealth();
  check(health?.status === 'ok', 'GET /health', `v${health?.version}`);
  check(
    health?.version !== undefined && health.version !== '0.0.0-dev',
    'POCKETAGENT_BUILD_VERSION was stamped into the image',
    health?.version,
  );
  // PA-65 AC 1 and 2: the running server reports exactly the version the image
  // was built with — never `unknown`, and never the package.json fallback.
  check(health?.version === imageStamp, '/health reports the stamped semver', health?.version);
  check(health?.version !== 'unknown', '/health is never `unknown`');
  check(Array.isArray(health?.protocol) || typeof health?.protocol === 'object', 'protocol range advertised');
}

heading('The web bundle is served by the same process, with no Hub');
{
  const res = await fetch(`${BASE}/`);
  const html = await res.text();
  check(res.status === 200 && html.includes('PocketAgent'), 'GET / returns the SPA shell');
  const asset = html.match(/src="([^"]+\.js)"/)?.[1];
  const assetRes = asset ? await fetch(`${BASE}${asset}`) : null;
  check(assetRes?.status === 200, 'hashed bundle asset served', asset);

  // The other half of the version stamp, and the one PA-65 scope item 2 is
  // about: `__APP_VERSION__` is a Vite `define`, frozen into the JS at build
  // time. Inside a build context that (correctly) excludes `.git`, the old
  // `git rev-parse` path returned `unknown` for every published image, so the
  // UI's own footer could not say what it was running. Grepping the built
  // assets rather than the one entry chunk we happen to have fetched: which
  // chunk the string lands in is a bundler decision, not a contract.
  const stamped = inContainer(
    `grep -rl -- '${imageStamp}' /app/apps/web/dist/assets 2>/dev/null | head -1`,
  );
  check(stamped.stdout !== '', 'the web bundle carries the same version', stamped.stdout);
  const unknown = inContainer(
    `grep -rl -- 'APP_VERSION="unknown"' /app/apps/web/dist/assets 2>/dev/null | head -1`,
  );
  check(unknown.stdout === '', 'no asset reports the version as `unknown`');
}

heading('It runs as the host uid, not root');
{
  const whoami = inContainer('id -u');
  check(whoami.stdout === String(HOST_UID), 'server process uid matches the host', whoami.stdout);
  const homeOwner = inContainer('stat -c %u "$HOME"');
  check(homeOwner.stdout === String(HOST_UID), 'HOME is owned by that uid');
}

// PA-104: the order `agents/registry.ts` resolves agents in — official
// locations first, npm install prefix last. A login shell has to agree with
// the server or a human and the server run different binaries, which is the
// bug PA-104 exists to fix.
const OFFICIAL_DIRS = [
  '/home/pocketagent/.opencode/bin',
  '/home/pocketagent/.local/bin',
  '/home/pocketagent/.pi/agent/bin',
];
const PREFIX_BIN = '/home/pocketagent/.npm-global/bin';

function checkLoginPath(shell) {
  // /etc/profile overwrites PATH unconditionally on bash login shells, and
  // planner/tools.ts runs exec_command as `$SHELL -lc`. Without
  // /etc/profile.d/10-pocketagent-path.sh an agent installed into $HOME is
  // invisible to exactly the surface most likely to look for it.
  const loginPath = tryRun('docker', [
    'exec', '--user', `${HOST_UID}:${HOST_GID}`, CONTAINER, shell, '-lc', 'echo "$PATH"',
  ]);
  const order = loginPath.stdout.split(':');
  check(
    OFFICIAL_DIRS.every((dir, i) => order[i] === dir),
    `${shell}: login shell PATH starts with the official agent directories`,
    order.slice(0, 3).join(':'),
  );
  check(
    order.indexOf('/home/pocketagent/.local/bin') < order.indexOf('/usr/local/bin'),
    `${shell}: official directories precede /usr/local/bin (a run-time install or self-update wins over the image's copy)`,
  );
  // The snippet can be applied more than once in one login (profile.d and an
  // rc file both), so PATH may repeat itself; what matters is where the
  // prefix *first* appears — after every system directory.
  check(
    order.indexOf(PREFIX_BIN) > order.lastIndexOf('/usr/local/bin') &&
      order.indexOf(PREFIX_BIN) > order.lastIndexOf('/usr/bin'),
    `${shell}: the npm install prefix comes after the system PATH (it can never shadow an official copy)`,
  );
}

heading('A login shell has the agent directories on PATH, in the resolver\'s order');
checkLoginPath('bash');

heading('A zsh login shell has them too (PA-79)');
checkLoginPath('zsh');

heading('Ubuntu 26.04 base and zsh shell environment (PA-79)');
{
  const osRelease = inContainer('cat /etc/os-release');
  check(osRelease.stdout.includes('Ubuntu 26.04'), 'os-release reports Ubuntu 26.04', osRelease.stdout.split('\n')[0]);
  const userShell = inContainer('getent passwd pocketagent');
  check(userShell.stdout.trim().endsWith('/bin/zsh'), 'pocketagent user shell is /bin/zsh', userShell.stdout.trim());
  const zshrc = inContainer('test -f "$HOME/.zshrc" && echo ok');
  check(zshrc.stdout.trim() === 'ok', '.zshrc exists in HOME');
  const omz = inContainer('test -d "$HOME/.oh-my-zsh" && echo ok');
  check(omz.stdout.trim() === 'ok', '.oh-my-zsh exists in HOME');
}

heading('git works inside the mounted repo');
{
  // The uid match is what makes this pass. A mismatch produces "detected
  // dubious ownership", which breaks git/status.ts and every worktree
  // operation — not just file ownership.
  const status = inContainer(`cd ${workspace} && git status --porcelain=2 --branch`);
  check(status.status === 0, 'git status succeeds', status.status === 0 ? 'clean' : status.stderr.slice(0, 80));
  check(!status.stderr.includes('dubious ownership'), 'no dubious-ownership refusal');
}

// ---------------------------------------------------------------------------
// The API, spoken the way the browser speaks it.
// ---------------------------------------------------------------------------
let cookie = '';
async function call(pathname, init = {}) {
  const res = await fetch(BASE + pathname, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...init.headers,
    },
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

heading('Log in');
{
  const wrong = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ token: 'definitely-the-wrong-token-value' }),
  });
  check(wrong.status === 401, 'wrong token rejected', `HTTP ${wrong.status}`);
  const good = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
  check(good.status === 200, 'correct token accepted', `HTTP ${good.status}`);
  check(cookie.startsWith('pocketagent_sid='), 'received a session cookie over plain HTTP');
}

heading('The mounted workspace was seeded as a project folder');
{
  const { body } = await call('/api/workspaces');
  const paths = (body?.workspaces ?? []).map((w) => w.path);
  check(paths.includes(workspace), 'workspace root is listed', paths.join(', '));
}

/** Browser-equivalent socket, trimmed to what this script asserts on. */
function openSocket() {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/ws?v=${PROTOCOL_VERSION}`, {
    headers: { cookie },
  });
  const state = { output: '', lastSeq: 0, messages: [] };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    state.messages.push(m);
    if (m.type === 'attached') {
      state.output += m.replay.data;
      state.lastSeq = Math.max(state.lastSeq, m.replay.toSeq);
    } else if (m.type === 'output' && m.seq > state.lastSeq) {
      state.lastSeq = m.seq;
      state.output += m.data;
    }
  });
  return {
    ready: new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    }),
    state,
    send: (m) => ws.send(JSON.stringify(m)),
    waitFor: async (predicate, timeout = 20_000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (predicate(state)) return true;
        await sleep(40);
      }
      return false;
    },
    close: () => new Promise((r) => (ws.once('close', r), ws.close(), setTimeout(r, 400))),
  };
}

const AGENT_FILE = 'written-by-the-agent.txt';
let sessionId;
heading('Create a session and run a command in the mounted repo');
{
  // The `shell` agent, deliberately: it is always available because it is
  // $SHELL, so the *thin* image is fully verifiable without installing any
  // agent CLI — which is the whole premise of the thin tag.
  const { status, body } = await call('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ agent: 'shell', cwd: workspace, cols: 90, rows: 26 }),
  });
  sessionId = body?.id;
  check(status === 201 && body?.status === 'running', 'session created', `id=${sessionId} pid=${body?.pid}`);

  const sock = openSocket();
  await sock.ready;
  sock.send({ type: 'attach', sessionId, afterSeq: 0 });
  await sock.waitFor((s) => s.messages.some((m) => m.type === 'attached'));
  sock.send({ type: 'input', sessionId, data: `echo agent-was-here > ${AGENT_FILE}\n` });
  sock.send({ type: 'input', sessionId, data: 'echo DONE-MARKER\n' });
  const got = await sock.waitFor((s) => (s.output.match(/DONE-MARKER/g) ?? []).length >= 2);
  check(got, 'command ran in the PTY');
  await sock.close();
}

heading('AC2: files the agent wrote are owned by the host user, not root');
{
  const written = path.join(workspace, AGENT_FILE);
  const exists = fs.existsSync(written);
  check(exists, 'file is visible on the host', written);
  if (exists) {
    const stat = fs.statSync(written);
    check(stat.uid === HOST_UID, 'uid matches the host user', `uid=${stat.uid} (host ${HOST_UID})`);
    check(stat.gid === HOST_GID, 'gid matches the host group', `gid=${stat.gid} (host ${HOST_GID})`);
    check(stat.uid !== 0, 'not root-owned');
  }
}

heading('Install an "agent" into its official location in $HOME');
{
  // A stand-in binary rather than a real vendor installer: what is under test
  // is that ~/.local/bin — where the official installers link claude, codex
  // and agy (PA-104) — is on the mounted volume and on PATH.
  const install = inContainer(
    'mkdir -p "$HOME/.local/bin" && ' +
      'printf "#!/bin/sh\\necho fake-agent-2.0\\n" > "$HOME/.local/bin/fake-agent" && ' +
      'chmod +x "$HOME/.local/bin/fake-agent" && fake-agent',
  );
  check(install.status === 0 && install.stdout.includes('fake-agent-2.0'), 'installed and resolvable on PATH');
  check(
    fs.existsSync(path.join(homeDir, '.local/bin/fake-agent')),
    'landed in the mounted $HOME volume, not a layer',
  );
}

heading('AC1: a container restart leaves state intact');
{
  const beforeSessions = (await call('/api/sessions')).body?.sessions?.length ?? 0;
  const dbBefore = fs.statSync(path.join(dataDir, 'pocketagent.db')).size;

  run('docker', ['restart', '--time', '30', CONTAINER]);
  cookie = '';
  const after = await waitForHealth();
  check(after?.status === 'ok', 'container came back', `v${after?.version}`);

  check(fs.existsSync(path.join(dataDir, 'pocketagent.db')), 'database survived');
  const dbAfter = fs.statSync(path.join(dataDir, 'pocketagent.db')).size;
  check(dbAfter >= dbBefore, 'database was reopened, not recreated', `${dbBefore} -> ${dbAfter} bytes`);

  // The Pocket Agent scratch workspace and the skills root are the other two
  // directories POCKETAGENT_DATA_DIR moves (PA-62); if only the database had
  // been mounted they would be back to their seeded state here.
  check(fs.existsSync(path.join(dataDir, 'planner-workspaces')), 'planner-workspaces survived');
  check(fs.existsSync(path.join(dataDir, 'planner-skills')), 'planner-skills survived');

  const stillThere = inContainer('command -v fake-agent && fake-agent');
  check(stillThere.status === 0, 'the installed agent survived and is still on PATH');

  const login = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
  check(login.status === 200, 'can log in again');

  const sessions = (await call('/api/sessions')).body?.sessions ?? [];
  const row = sessions.find((s) => s.id === sessionId);
  check(beforeSessions > 0 && sessions.length > 0, 'session rows persisted', `${sessions.length} row(s)`);
  // The `direct` backend means the PTY itself is gone, and the server says so
  // rather than pretending — Known Limitation #2, now also the container story.
  check(
    row === undefined || row.status !== 'running',
    'the PTY is honestly reported as not running',
    row?.status,
  );

  const { body: projects } = await call('/api/projects');
  const cwds = (projects?.projects ?? []).map((p) => p.cwd);
  check(cwds.includes(workspace), 'the project is still listed after the restart');
}

heading('A pinned agent CLI survives the $HOME mount (if that tag is built)');
{
  // The one failure mode unique to the -claude/-all tags, and it shipped
  // broken once: npm reads its environment config case-insensitively, so the
  // image's own NPM_CONFIG_PREFIX ($HOME/.npm-global) silently won over a
  // lowercase `npm_config_prefix=/usr/local` on the install command — putting
  // the pinned CLI in the one directory a volume mount hides. `claude
  // --version` passed anyway, because it was still on PATH *at build time*.
  // What has to be asserted is the location, and that the server still sees it
  // once $HOME is a mount.
  const tag = `${IMAGE}:latest-claude`;
  const present = tryRun('docker', ['image', 'inspect', '-f', '{{.Id}}', tag]).status === 0;
  if (!present) {
    ok(`skipped — ${tag} not built locally (docker/build.sh claude)`);
  } else {
    const where = tryRun('docker', ['run', '--rm', '--entrypoint', 'sh', tag, '-c', 'command -v claude']);
    check(where.stdout === '/usr/local/bin/claude', 'pinned CLI is linked into /usr/local/bin', where.stdout);
    // PA-104: installed by the official installer, in the official layout
    // (under the image's build-time HOME, outside every mount).
    const target = tryRun('docker', ['run', '--rm', '--entrypoint', 'sh', tag, '-c', 'readlink -f "$(command -v claude)"']);
    check(
      target.stdout.startsWith('/opt/pocketagent-agents/.local/share/claude/versions/'),
      'pinned CLI is an official install, not an npm copy',
      target.stdout,
    );

    // Started with the *same* mounts as the thin container above, so $HOME is
    // a populated volume that could shadow a badly placed install.
    const probe = 'pa-smoke-claude';
    tryRun('docker', ['rm', '-f', probe]);
    run('docker', [
      'run', '--detach', '--name', probe,
      '--env', `POCKETAGENT_AUTH_TOKEN=${TOKEN}`,
      '--env', `POCKETAGENT_WORKSPACE_ROOTS=${workspace}`,
      '--env', `PUID=${HOST_UID}`, '--env', `PGID=${HOST_GID}`,
      '--volume', `${homeDir}:/home/pocketagent`,
      '--volume', `${workspace}:${workspace}`,
      tag,
    ]);
    const resolved = tryRun('docker', [
      'exec', '--user', `${HOST_UID}:${HOST_GID}`, probe, 'bash', '-lc', 'command -v claude',
    ]);
    check(
      resolved.stdout === '/usr/local/bin/claude',
      'still resolvable with $HOME mounted over the agent prefix',
      resolved.stdout,
    );
    tryRun('docker', ['rm', '-f', probe]);
  }
}

heading('AC3: the documented extension example builds and starts');
{
  run('docker', [
    'build', '--quiet',
    '--file', 'docker/extend.example.Dockerfile',
    '--tag', EXTEND_IMAGE,
    '.',
  ], { cwd: REPO });
  ok('docker build -f docker/extend.example.Dockerfile');
  const version = tryRun('docker', [
    'run', '--rm',
    '--entrypoint', 'node',
    EXTEND_IMAGE,
    '-e', 'console.log(require("/app/apps/server/package.json").version)',
  ]);
  check(version.status === 0, 'the extended image runs the server tree', version.stdout);
  const rg = tryRun('docker', ['run', '--rm', '--entrypoint', 'rg', EXTEND_IMAGE, '--version']);
  check(rg.status === 0, 'the extra tool is present', rg.stdout.split('\n')[0]);
  const stillNonRoot = tryRun('docker', [
    'run', '--rm',
    '--env', `POCKETAGENT_AUTH_TOKEN=${TOKEN}`,
    '--env', `PUID=${HOST_UID}`,
    '--env', `PGID=${HOST_GID}`,
    EXTEND_IMAGE,
    'id', '-u',
  ]);
  check(stillNonRoot.stdout === String(HOST_UID), 'the entrypoint still drops privileges', stillNonRoot.stdout);
}

heading('An unwritable mount is refused with the fix in the message');
{
  // The other half of "never chown a mounted volume": if the entrypoint will
  // not take ownership, it has to say so clearly instead of letting the
  // server fail later with a SQLite error.
  const locked = path.join(tmp, 'locked');
  fs.mkdirSync(locked, { recursive: true });
  fs.chmodSync(locked, 0o500);
  const res = tryRun('docker', [
    'run', '--rm',
    '--env', `POCKETAGENT_AUTH_TOKEN=${TOKEN}`,
    '--env', 'PUID=65534',
    '--env', 'PGID=65534',
    '--volume', `${locked}:/data`,
    `${IMAGE}:latest`,
  ]);
  check(res.status === 78, 'exits 78 (EX_CONFIG), as a ConfigError would', `exit ${res.status}`);
  check(res.stderr.includes('chown'), 'the message names the chown to run');
  check(
    fs.statSync(locked).uid === HOST_UID,
    'the mount was NOT chowned',
    `still uid ${fs.statSync(locked).uid}`,
  );
}

console.log('\n' + '='.repeat(60));
if (failures > 0) {
  console.log(`${failures} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('All checks passed.');
}

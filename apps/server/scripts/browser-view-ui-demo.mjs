#!/usr/bin/env node
/**
 * PA-178's acceptance criteria, in real Chrome, at a phone and a desktop
 * viewport, against a real shared Chromium:
 *
 * - a Pocket Agent calls `request_browser_help` (from a fake LLM); the chat
 *   shows the card, the turn stays parked, and "Open browser" opens the viewer
 *   on the login page the agent named;
 * - a person signs in to a local test site *through the viewer* — taps on the
 *   frame, the soft keyboard (phone) or captured keys (desktop) — and the
 *   agent's side (`playwright-cli attach --cdp=…`, else a CDP connection) sees
 *   the logged-in state;
 * - "Done" resumes the turn with the page the person left; a JS dialog is
 *   answered from the viewer; `file://` is refused by the URL bar;
 * - frames stop while the page is hidden;
 * - the login survives a server restart (persistent profile, graceful close).
 *
 * Needs no running server: it starts a scratch backend (throwaway data root,
 * workspace and HOME — never the real database), a fake OpenAI-compatible
 * endpoint and a local login site, all on loopback. Needs a Playwright
 * Chromium for the shared browser (`PLAYWRIGHT_BROWSERS_PATH`, or
 * `PA_SHARED_BROWSERS_PATH` when it differs from the demo's own; the `all`
 * image has one at `/opt/pw-browsers`) and one for the demo's own Chrome.
 *
 * `pnpm build` first. Run with: pnpm demo:browser-view
 */
import { spawn, execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';

let step = 0;
let failures = 0;
const ok = (label, detail = '') => console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail = '') => {
  failures += 1;
  console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
};
const check = (cond, label, detail) => (cond ? ok(label, detail) : bad(label, detail));
const heading = (title) => console.log(`\n[${++step}] ${title}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const SHOTS = path.join(REPO_ROOT, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-browser-demo-')));
const MASTER = crypto.randomBytes(32).toString('base64url');
const PORT = 19_000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'hunter2-PA178-demo';

const dataDir = path.join(scratch, 'data');
const workspace = path.join(scratch, 'workspace');
const home = path.join(scratch, 'home');
for (const dir of [dataDir, path.join(workspace, 'demo-project'), home]) fs.mkdirSync(dir, { recursive: true });

// ---- a local login site -------------------------------------------------------
const site = http.createServer(async (req, res) => {
  const cookie = req.headers.cookie ?? '';
  if (req.method === 'POST' && req.url === '/login') {
    let body = '';
    for await (const c of req) body += c;
    const p = new URLSearchParams(body);
    if (p.get('user') === 'ada' && p.get('pass') === PASSWORD) {
      res.writeHead(302, { 'set-cookie': 'sid=ok; Path=/; Max-Age=86400; HttpOnly', location: '/' });
      return res.end();
    }
    res.writeHead(401, { 'content-type': 'text/html' });
    return res.end('<h1 id=state>Wrong password</h1>');
  }
  if (req.url === '/dialog') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(
      '<meta name=viewport content="width=device-width"><button id=ask style="font-size:32px;margin:40px" onclick="document.title=confirm(\'Proceed?\')?\'yes\':\'no\'">Ask</button>',
    );
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (cookie.includes('sid=ok')) {
    return res.end('<meta name=viewport content="width=device-width"><h1 id=state>LOGGED IN as ada</h1>');
  }
  res.end(`<meta name=viewport content="width=device-width"><title>Sign in</title><h1 id=state>Please sign in</h1>
<form method=post action=/login style="font-size:22px">
<input id=user name=user autocomplete=off style="font-size:22px;width:90%;padding:8px"><br><br>
<input id=pass name=pass type=password style="font-size:22px;width:90%;padding:8px"><br><br>
<button id=submit style="font-size:22px">Sign in</button></form>`);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}`;

// ---- a fake LLM: asks for browser help once per chat, then answers ---------------
const llmSeen = new Map();
const llm = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      /* a probe */
    }
    const first = parsed.messages?.[0];
    const isTitle = first?.role === 'system' && String(first.content).startsWith('You write titles for chat conversations');
    const hasToolResult = (parsed.messages ?? []).some((m) => m.role === 'tool');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (isTitle || hasToolResult) {
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: isTitle ? 'Dashboard check' : 'Signed in — carrying on.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    llmSeen.set('asked', (llmSeen.get('asked') ?? 0) + 1);
    const call = {
      index: 0,
      id: `call_${crypto.randomUUID().slice(0, 8)}`,
      function: { name: 'request_browser_help', arguments: JSON.stringify({ reason: 'Please sign in to the demo site as ada.', url: `${SITE}/` }) },
    };
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  });
});
await new Promise((r) => llm.listen(0, '127.0.0.1', r));
const LLM_URL = `http://127.0.0.1:${llm.address().port}/v1`;

// ---- the scratch server ---------------------------------------------------------
let server = null;
/** Both runs' output, for the "nothing was logged" checks. */
let allLogs = '';
function startServer() {
  // Killed by its own pid, never by pattern — see CLAUDE.md's 2026-09-17 note.
  server = spawn(process.execPath, ['apps/server/dist/server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      HOST: '127.0.0.1',
      PORT: String(PORT),
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      POCKETAGENT_AUTH_TOKEN: MASTER,
      POCKETAGENT_WORKSPACE_ROOTS: workspace,
      POCKETAGENT_DATA_DIR: dataDir,
      POCKETAGENT_BACKEND: 'direct',
      POCKETAGENT_COOKIE_SECURE: 'false',
      POCKETAGENT_ADOPT_TMUX_SOCKET: '',
      // The shared browser may live somewhere other than the demo's own
      // Playwright browsers (the image's `/opt/pw-browsers` vs a dev cache).
      ...(process.env.PA_SHARED_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PA_SHARED_BROWSERS_PATH } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (c) => (allLogs += c));
  server.stderr.on('data', (c) => (allLogs += c));
}
async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  const exited = new Promise((r) => s.once('exit', r));
  s.kill('SIGTERM'); // graceful: closes the shared browser with Browser.close
  await Promise.race([exited, sleep(15_000)]);
  try {
    s.kill('SIGKILL');
  } catch {
    /* gone */
  }
}
let browser = null;
const cleanup = () => {
  try {
    server?.kill('SIGKILL');
  } catch {
    /* gone */
  }
  site.close();
  llm.close();
  try {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    console.log(`(scratch left at ${scratch})`);
  }
};
process.on('exit', cleanup);

async function waitForHealth() {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return true;
    } catch {
      /* not yet */
    }
    await sleep(150);
  }
  return false;
}

async function launch() {
  for (const options of [{}, { args: ['--no-sandbox'] }, { channel: 'chromium', args: ['--no-sandbox'] }]) {
    try {
      return await chromium.launch(options);
    } catch {
      /* try next */
    }
  }
  throw new Error('no usable browser for the demo');
}

async function loggedIn(contextOptions) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('#token', MASTER);
  await page.click('button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#token'), null, { timeout: 15_000 });
  const api = async (method, url, body) => {
    const res = await context.request.fetch(`${BASE}${url}`, {
      method,
      headers: { origin: BASE, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { data: body } : {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* SSE */
    }
    return { status: res.status(), json, text };
  };
  return { context, page, api, errors };
}

/** The agent's side: the shared browser over CDP, as `playwright-cli attach` reaches it. */
async function agentSide(cdpUrl) {
  const remote = await chromium.connectOverCDP(cdpUrl);
  const pages = remote.contexts().flatMap((c) => c.pages());
  return { remote, pages };
}

/**
 * Asynchronously, and that matters: this process also holds a Playwright CDP
 * connection to the same browser, which pauses each new page until every
 * attached client lets it run. A blocking spawn would starve that connection
 * and wedge playwright-cli's own `goto`.
 */
function playwrightCli(args) {
  return new Promise((resolve) => {
    execFile(
      'playwright-cli',
      args,
      { cwd: scratch, encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: home } },
      (err, stdout) => resolve(err ? `ERROR ${err.message} ${stdout ?? ''}` : stdout),
    );
  });
}
const hasPlaywrightCli = (() => {
  try {
    execFileSync('playwright-cli', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Tap the remote element `selector` *through the viewer*: find it on the page, tap its spot on the frame. */
async function tapRemote(page, remotePage, selector, { touch }) {
  const box = await remotePage.evaluate((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: innerWidth, h: innerHeight };
  }, selector);
  const img = await page.locator('.browser-frame').boundingBox();
  const x = img.x + (box.x / box.w) * img.width;
  const y = img.y + (box.y / box.h) * img.height;
  if (touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
  await sleep(400);
}

if (!fs.existsSync(path.join(REPO_ROOT, 'apps/server/dist/server.js'))) {
  console.log('Run `pnpm build` first.');
  process.exit(1);
}
startServer();
if (!(await waitForHealth())) {
  console.log('server did not start\n' + allLogs);
  process.exit(1);
}
browser = await launch();
console.log('PocketAgent PA-178 live browser view demo\n' + '='.repeat(60));

let browserId = null;

for (const [label, contextOptions] of [
  ['phone (iPhone 13)', { ...devices['iPhone 13'] }],
  ['desktop (1280×900)', { viewport: { width: 1280, height: 900 } }],
]) {
  const touch = label.startsWith('phone');
  const tag = touch ? 'phone' : 'desktop';
  const { context, page, api, errors } = await loggedIn(contextOptions);

  heading(`${label}: the agent asks for help`);
  const list = await api('GET', '/api/browsers');
  check(list.status === 200 && list.json?.available === true, 'the host reports a shared browser is available', list.json?.unavailableReason ?? '');
  await api('PATCH', '/api/planner/settings', { baseUrl: LLM_URL });
  const chat = (await api('POST', '/api/planner/chats', { modelId: 'fake-model' })).json;
  browserId = `pocket-${chat.workspaceId}`;
  // Clear the previous viewport's login so each one signs in for itself.
  const stopped = await api('POST', `/api/browsers/${browserId}/stop`);
  const cleared = await api('POST', `/api/browsers/${browserId}/clear-data`);
  check(stopped.status === 200 && cleared.status === 200, 'starts from a stopped browser with an empty profile', `${stopped.status}/${cleared.status} ${cleared.json?.error?.message ?? ''}`);
  const sent = await api('POST', `/api/planner/chats/${chat.id}/messages`, { content: 'Check my dashboard' });
  check(sent.text.includes('browser_help_request'), 'the turn parks on request_browser_help');
  check(!sent.text.includes('"turn_complete"'), 'and does not finish');
  await page.goto(`${BASE}/#/planner/${chat.id}`, { waitUntil: 'networkidle' });
  await page.locator('.browser-help-card:visible').waitFor({ timeout: 15_000 });
  ok('the chat shows the handoff card', await page.locator('.browser-help-card .browser-help-reason').innerText());
  check((await page.locator('.browser-btn:visible').count()) > 0, 'the chat header offers the Browser button');
  await page.locator('.browser-help-card button', { hasText: 'Open browser' }).click();
  await page.waitForFunction((id) => location.hash.includes(`/browser/${id}`), browserId);
  ok('Open browser goes to the viewer', await page.evaluate(() => location.hash));

  heading(`${label}: a person signs in through the viewer`);
  await page.locator('.browser-frame').waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('.browser-help-bar').waitFor({ timeout: 10_000 });
  // The frame must actually decode — a CSP-blocked image still has a box, so
  // taps mapped from it would land while the person saw nothing.
  await page.waitForFunction(() => (document.querySelector('.browser-frame')?.naturalWidth ?? 0) > 0, null, { timeout: 10_000 }).catch(() => undefined);
  const natural = await page.evaluate(() => document.querySelector('.browser-frame')?.naturalWidth ?? 0);
  check(natural > 0, 'the frame renders (decoded, not CSP-blocked)', `${natural}px wide`);
  ok('the viewer shows who is waiting', await page.locator('.browser-help-text strong').innerText());
  const info = (await api('GET', '/api/browsers')).json.browsers.find((b) => b.id === browserId);
  check(/^http:\/\/127\.0\.0\.1:\d+$/.test(info?.cdpUrl ?? ''), 'its CDP endpoint is loopback-only', info?.cdpUrl);
  const { remote, pages } = await agentSide(info.cdpUrl);
  const loginPage = pages.filter((p) => p.url() === `${SITE}/`).at(-1);
  check(Boolean(loginPage), 'the viewer opened on the page the agent named', loginPage?.url());
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SHOTS, `pa178-${tag}-viewer-login.png`) });

  await tapRemote(page, loginPage, '#user', { touch });
  if (touch) {
    await page.locator('.browser-toolbar button[aria-label=Keyboard]').click();
    await page.locator('.browser-keyboard').pressSequentially('ada', { delay: 30 });
  } else {
    await page.keyboard.type('ada', { delay: 30 });
  }
  await tapRemote(page, loginPage, '#pass', { touch });
  if (touch) {
    await page.locator('.browser-keyboard').focus();
    await page.locator('.browser-keyboard').pressSequentially(PASSWORD, { delay: 20 });
    await page.locator('.browser-keyboard').press('Enter');
  } else {
    await page.keyboard.type(PASSWORD, { delay: 20 });
    await page.keyboard.press('Enter');
  }
  await loginPage.waitForFunction(() => document.getElementById('state')?.textContent?.includes('LOGGED IN'), null, { timeout: 15_000 }).catch(() => undefined);
  const state = await loginPage.evaluate(() => document.getElementById('state')?.textContent ?? '');
  check(state.includes('LOGGED IN'), 'the sign-in typed in the viewer reached the page', state);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SHOTS, `pa178-${tag}-viewer-signed-in.png`) });

  heading(`${label}: the agent's side sees the login`);
  if (hasPlaywrightCli) {
    const attach = await playwrightCli([`-s=pa178-${tag}`, 'attach', `--cdp=${info.cdpUrl}`]);
    const goto = await playwrightCli([`-s=pa178-${tag}`, 'goto', `${SITE}/`]);
    const out = await playwrightCli([`-s=pa178-${tag}`, 'eval', "document.getElementById('state').textContent"]);
    check(
      out.includes('LOGGED IN'),
      'playwright-cli attach --cdp=… + goto is already logged in',
      out.includes('LOGGED IN') ? '' : `${attach.slice(-300)} | ${goto.slice(-300)} | ${out.slice(-300)}`,
    );
    const detached = await playwrightCli([`-s=pa178-${tag}`, 'detach']);
    check(!detached.startsWith('ERROR'), 'playwright-cli detach leaves the shared browser running');
  } else {
    const fresh = await loginPage.context().newPage();
    await fresh.goto(`${SITE}/`);
    check((await fresh.textContent('#state')).includes('LOGGED IN'), 'a new tab over CDP is already logged in (playwright-cli not installed)');
    await fresh.close();
  }

  heading(`${label}: the URL bar, a dialog, and visibility`);
  await page.locator('.browser-url input').fill('file:///etc/passwd');
  await page.locator('.browser-url input').press('Enter');
  await page.locator('.browser-note[role=alert]').waitFor({ timeout: 5000 });
  check(!loginPage.url().startsWith('file:'), 'file:// is refused by the URL bar', await page.locator('.browser-note[role=alert]').innerText());
  await page.locator('.browser-note[role=alert] button').click();
  await page.locator('.browser-url input').fill(`${SITE}/dialog`);
  await page.locator('.browser-url input').press('Enter');
  await sleep(1200);
  const active = remote.contexts().flatMap((c) => c.pages()).find((p) => p.url() === `${SITE}/dialog`) ?? loginPage;
  // An attached Playwright client auto-dismisses any dialog it has no handler
  // for — so an agent attached with no dialog handling answers it before a
  // person can (a documented limitation). This stand-in agent declines to.
  active.on('dialog', () => undefined);
  await tapRemote(page, active, '#ask', { touch });
  await page.locator('.dialog[aria-label="Page dialog"]').waitFor({ timeout: 8000 });
  ok('the page’s confirm() appears in the viewer', await page.locator('.browser-dialog-message').innerText());
  await page.locator('.dialog[aria-label="Page dialog"] button', { hasText: 'OK' }).click();
  // Read back from Chromium's own target list rather than through the
  // stand-in agent's Playwright connection, whose view of a page whose dialog
  // someone *else* answered is not to be trusted.
  let titleAfter = '';
  for (let i = 0; i < 40 && titleAfter !== 'yes'; i++) {
    const targets = await (await fetch(`${info.cdpUrl}/json/list`)).json();
    titleAfter = targets.find((t) => t.type === 'page' && t.url === `${SITE}/dialog`)?.title ?? '';
    if (titleAfter !== 'yes') await sleep(200);
  }
  const viewerNotice = await page.locator('.browser-note[role=alert]').allInnerTexts();
  check(titleAfter === 'yes', 'answering OK in the viewer accepted it on the page', `title=${titleAfter} notices=${viewerNotice.join('|')}`);

  const frameCount = () =>
    page.evaluate(() => {
      const img = document.querySelector('.browser-frame');
      if (!window.__paFrames) {
        window.__paFrames = 0;
        new MutationObserver(() => (window.__paFrames += 1)).observe(img, { attributes: true, attributeFilter: ['src'] });
      }
      return window.__paFrames;
    });
  await frameCount();
  // A repainting page, so frames would flow if allowed to.
  await active.evaluate(() => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;top:0;left:0;width:60px;height:60px;background:red';
    document.body.append(d);
    let a = 0;
    setInterval(() => (d.style.transform = `rotate(${(a += 9)}deg)`), 30);
  });
  await sleep(1200);
  const visibleFrames = await frameCount();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await sleep(600);
  const atHide = await frameCount();
  await sleep(1500);
  const hiddenDelta = (await frameCount()) - atHide;
  check(visibleFrames > 3 && hiddenDelta === 0, 'frames stop while the page is hidden', `visible: ${visibleFrames}, hidden 1.5 s: ${hiddenDelta}`);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  heading(`${label}: Done hands the browser back`);
  await page.locator('.browser-help-actions button', { hasText: 'Done' }).click();
  let finished = false;
  for (let i = 0; i < 60 && !finished; i++) {
    const h = await api('GET', `/api/planner/chats/${chat.id}/history`);
    const events = h.json?.events ?? [];
    finished = events.some((e) => e.kind === 'turn_complete');
    if (finished) {
      const result = events.filter((e) => e.kind === 'tool_result').at(-1);
      check(String(result?.content).includes('pressed Done'), 'the turn resumed with the page the person left', String(result?.content).split('\n')[0]);
    }
    await sleep(250);
  }
  check(finished, 'and finished');
  await page.locator('.browser-help-bar').waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
  check((await page.locator('.browser-help-bar').count()) === 0, 'the viewer no longer asks');
  check(errors.length === 0, 'no page errors', errors.join('; '));
  await remote.close();
  await context.close();
}

heading('the login survives a server restart');
await stopServer();
startServer();
check(await waitForHealth(), 'the scratch server came back on the same data root');
{
  const { context, api } = await loggedIn({ viewport: { width: 800, height: 600 } });
  const started = await api('POST', `/api/browsers/${browserId}/start`);
  check(started.status === 200, 'the shared browser starts again', started.json?.cdpUrl);
  const { remote, pages } = await agentSide(started.json.cdpUrl);
  const p = pages[0] ?? (await remote.contexts()[0].newPage());
  await p.goto(`${SITE}/`);
  check((await p.textContent('#state')).includes('LOGGED IN'), 'the agent is still signed in after the restart');
  await remote.close();
  await context.close();
}

heading('nothing a person typed reached the log');
check(!allLogs.includes(PASSWORD), 'the password is in no log line');
check(!allLogs.includes('/9j/'), 'no screencast frame is in the log');
check(/browser viewer opened/.test(allLogs) && !allLogs.includes(`${SITE}/dialog`), 'a viewer is logged by id only, never the pages it showed');

await browser.close();
await stopServer();
console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}  Screenshots in ${SHOTS}`);
process.exit(failures === 0 ? 0 : 1);

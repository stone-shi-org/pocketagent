#!/usr/bin/env node
/**
 * PA-110's acceptance criteria, in a real browser against real processes.
 *
 * Needs no running server: it starts a real Hub and (part way through) a real
 * backend, each with throwaway state, and drives Chrome at both a desktop and
 * a phone viewport:
 *
 *   1. A Hub with no hosts shows the Hub's own page — no "New chat", no host
 *      Settings — in both layouts, and its overflow menu offers Hub items only.
 *   2. A backend started with POCKETAGENT_MDNS_ADVERTISE=true appears under
 *      "On this network" over *real* multicast DNS, and "Add…" registers and
 *      binds it with the address prefilled.
 *   3. Selecting that host shows server UI with server-only menu items (no
 *      "Hosts…", no templates), and its Settings page no longer carries the
 *      Hub's templates card.
 *   4. Selecting the Hub tile again brings back Hub-only items.
 *   5. Stopping the backend takes it off the discovered list (its mDNS goodbye).
 *
 * The backend is bound to a container-bridge address when this machine has
 * one, so the scratch server is never reachable from the LAN even for the
 * minute this runs — multicast loopback still carries its advertisement to a
 * Hub on the same machine. Without a bridge it falls back to the first LAN
 * address and says so. mDNS needs UDP 5353 to be usable; on a machine where it
 * is not, step 2 fails with the Hub's own explanation.
 *
 * `pnpm build` first. Run with: pnpm demo:hub-ui
 * Screenshots land in $PA_SCREENSHOTS (default: a temp directory, printed).
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-hub-ui-demo-'));
const shots = process.env.PA_SCREENSHOTS ?? path.join(scratch, 'screenshots');
fs.mkdirSync(shots, { recursive: true });
// Kept past cleanup so the screenshots survive the run.
const keepShots = process.env.PA_SCREENSHOTS !== undefined;
const children = [];

const token = () => crypto.randomBytes(32).toString('base64url');
const HUB_TOKEN = token();
const HUB_ENC_KEY = crypto.randomBytes(32).toString('base64');
const BACKEND_TOKEN = token();
const HUB_PORT = 18000 + Math.floor(Math.random() * 1000);
const BACKEND_PORT = HUB_PORT + 1000;

function cleanup() {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  if (!keepShots) fs.rmSync(scratch, { recursive: true, force: true });
}
process.on('exit', cleanup);

/** A bridge address if there is one (never LAN-reachable), else the first LAN one. */
function backendBindAddress() {
  const bridge = /^(docker|br-|virbr)/;
  const all = Object.entries(os.networkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter((entry) => entry.family === 'IPv4' && !entry.internal)
      .map((entry) => ({ name, address: entry.address })),
  );
  return all.find((entry) => bridge.test(entry.name)) ?? all[0] ?? null;
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await predicate()) return true;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) return false;
    await sleep(150);
  }
}

function startHub() {
  const dataDir = path.join(scratch, 'hub');
  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, ['apps/hub/dist/server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      LOG_LEVEL: 'warn',
      POCKETAGENT_HUB_HOST: '127.0.0.1',
      POCKETAGENT_HUB_PORT: String(HUB_PORT),
      POCKETAGENT_HUB_AUTH_TOKEN: HUB_TOKEN,
      POCKETAGENT_HUB_DATA_DIR: dataDir,
      POCKETAGENT_SETTINGS_ENC_KEY: HUB_ENC_KEY,
      POCKETAGENT_COOKIE_SECURE: 'false',
      POCKETAGENT_HUB_MDNS: 'true',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[hub] ${chunk}`));
  children.push(child);
  return child;
}

function startBackend(host) {
  const dataDir = path.join(scratch, 'backend', 'data');
  const workspace = path.join(scratch, 'backend', 'workspace');
  const home = path.join(scratch, 'backend', 'home');
  for (const dir of [dataDir, workspace, home]) fs.mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, ['apps/server/dist/server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      HOST: host,
      PORT: String(BACKEND_PORT),
      NODE_ENV: 'development',
      LOG_LEVEL: 'warn',
      POCKETAGENT_AUTH_TOKEN: BACKEND_TOKEN,
      POCKETAGENT_WORKSPACE_ROOTS: workspace,
      POCKETAGENT_DATA_DIR: dataDir,
      POCKETAGENT_BACKEND: 'direct',
      POCKETAGENT_COOKIE_SECURE: 'false',
      POCKETAGENT_ADOPT_TMUX_SOCKET: '',
      POCKETAGENT_MDNS_ADVERTISE: 'true',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => {
    const text = String(chunk);
    if (/error|fatal|mdns/i.test(text)) process.stderr.write(`[backend] ${text}`);
  });
  children.push(child);
  return child;
}

async function launch() {
  for (const options of [{}, { channel: 'chrome' }, { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] }]) {
    try {
      return await chromium.launch(options);
    } catch {
      /* next */
    }
  }
  throw new Error('no usable Chromium');
}

const HUB = `http://127.0.0.1:${HUB_PORT}`;
let hubCookie = '';
async function hubApi(p, init = {}) {
  const response = await fetch(HUB + p, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(hubCookie ? { cookie: hubCookie } : {}),
    },
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) hubCookie = setCookie.split(';')[0];
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function login(page) {
  await page.goto(HUB, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="password"]', HUB_TOKEN);
  await page.press('input[type="password"]', 'Enter');
}

async function menuItems(page, trigger) {
  await page.click(trigger);
  await page.waitForSelector('.menu [role="menuitem"]');
  const items = await page.$$eval('.menu [role="menuitem"]', (nodes) => nodes.map((n) => n.textContent.trim()));
  await page.keyboard.press('Escape');
  return items;
}

const SERVER_ITEMS = ['Settings…', 'Cron jobs…', 'Webhooks…', 'Hidden projects…', 'Pocket Agent settings…'];
const HUB_ITEMS = ['Add host…', 'Config templates…'];
const has = (items, wanted) => wanted.every((item) => items.includes(item));
const hasNone = (items, unwanted) => unwanted.every((item) => !items.some((have) => have.startsWith(item)));

// ---------------------------------------------------------------------------

const bind = backendBindAddress();
if (!bind) {
  console.log('No non-loopback IPv4 interface — mDNS has nowhere to go. Skipping.');
  process.exit(1);
}
console.log(`Hub on ${HUB}; backend will bind ${bind.address}:${BACKEND_PORT} (${bind.name}). Screenshots: ${shots}`);

startHub();
if (!(await waitFor(async () => (await fetch(`${HUB}/health`)).ok))) {
  console.log('Hub never became healthy');
  process.exit(1);
}
await hubApi('/api/auth/login', { method: 'POST', body: JSON.stringify({ token: HUB_TOKEN }) });

const browser = await launch();
const desktop = await (await browser.newContext({ viewport: { width: 1360, height: 860 } })).newPage();
const phone = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage();

try {
  heading('A Hub with no hosts shows the Hub, not a dead server UI — desktop');
  await login(desktop);
  check(await waitFor(() => desktop.isVisible('.hub-page h1')), 'the Hub page is the home screen');
  check((await desktop.locator('.new-chat-btn').count()) === 0, 'no "New chat" button');
  check(await desktop.isVisible('.host-rail .host-tile.hub.active'), 'the rail’s Hub tile is selected');
  check(await desktop.isVisible('text=Add your first host'), 'an empty state that leads somewhere');
  const emptyMenu = await menuItems(desktop, '.sidebar-head button[aria-label="More"]');
  check(has(emptyMenu, HUB_ITEMS) && hasNone(emptyMenu, SERVER_ITEMS), 'overflow menu is Hub-only', emptyMenu.join(' | '));
  await desktop.screenshot({ path: path.join(shots, '1-empty-hub-desktop.png') });

  heading('…and on a phone');
  await login(phone);
  check(await waitFor(() => phone.isVisible('.hub-home .hub-page h1')), 'the phone lands on the Hub page');
  check((await phone.locator('.compose-fab').count()) === 0, 'no compose button');
  const phoneMenu = await menuItems(phone, '.home-bar button[aria-label="More"]');
  check(has(phoneMenu, HUB_ITEMS) && hasNone(phoneMenu, SERVER_ITEMS), 'phone overflow menu is Hub-only', phoneMenu.join(' | '));
  await phone.screenshot({ path: path.join(shots, '2-empty-hub-phone.png'), fullPage: true });

  heading('A backend advertising over real mDNS appears under "On this network"');
  const backend = startBackend(bind.address);
  const backendUrl = `http://${bind.address}:${BACKEND_PORT}`;
  check(await waitFor(async () => (await fetch(`${backendUrl}/health`)).ok, 20_000), 'backend is up', backendUrl);
  const heard = await waitFor(async () => {
    const { body } = await hubApi('/api/hub/discovery/refresh', { method: 'POST' });
    return body?.hosts?.some((h) => h.port === BACKEND_PORT);
  }, 20_000);
  const discovery = (await hubApi('/api/hub/discovery')).body;
  check(heard, 'the Hub heard it', heard ? '' : `state=${discovery?.state} ${discovery?.message ?? ''}`);
  const found = discovery?.hosts?.find((h) => h.port === BACKEND_PORT);
  check(found?.baseUrl === backendUrl, 'the suggested address is the one it is bound to', found?.baseUrl);
  const row = desktop.locator('.hub-discovered-row', { hasText: `:${BACKEND_PORT}` });
  check(await waitFor(() => row.isVisible(), 15_000), 'listed on the Hub page');
  await desktop.screenshot({ path: path.join(shots, '3-discovered-desktop.png') });

  heading('"Add…" registers and binds it, prefilled — and the Hub page stays put');
  await row.locator('button', { hasText: 'Add…' }).click();
  const dialog = '[role="dialog"][aria-label="Add host"]';
  await desktop.waitForSelector(dialog);
  const prefilled = await desktop.inputValue(`${dialog} .field:nth-of-type(2) input`);
  check(prefilled === backendUrl, 'address prefilled from the advertisement', prefilled);
  await desktop.fill(`${dialog} input[type="password"]`, BACKEND_TOKEN);
  await desktop.click(`${dialog} button.primary`);
  check(await waitFor(() => desktop.isVisible('.hub-host-card'), 15_000), 'a host card appears');
  check(await desktop.isVisible('.hub-page h1'), 'still on the Hub page after adding the first host');
  check(
    await waitFor(() => desktop.locator('.hub-host-card .host-dot:not(.offline):not(.unknown)').isVisible(), 15_000),
    'the new host reads online straight after binding',
  );
  check(
    await waitFor(() => row.locator('.hub-pill.ok', { hasText: 'Added' }).isVisible(), 15_000),
    'the discovered row now says "Added"',
  );
  check(
    await waitFor(async () => !(await desktop.isVisible('.hub-host-card dd.warn')), 10_000),
    'the card reads bound',
  );
  await desktop.screenshot({ path: path.join(shots, '4-added-desktop.png') });

  heading('Selecting the host shows server UI with server-only menu items');
  await desktop.click('.host-rail .host-tile:not(.hub):not(.add) >> nth=1');
  check(await waitFor(() => desktop.isVisible('.new-chat-btn')), 'the host view has "New chat"');
  check(!(await desktop.isVisible('.host-rail .host-tile.hub.active')), 'the Hub tile is no longer selected');
  const hostMenu = await menuItems(desktop, '.sidebar-head button[aria-label="More"]');
  check(
    has(hostMenu, SERVER_ITEMS) && hasNone(hostMenu, [...HUB_ITEMS, 'Hosts…', 'Hosts overview']),
    'overflow menu is server-only',
    hostMenu.join(' | '),
  );
  await desktop.click('.sidebar-head button[aria-label="More"]');
  // Exact: "Pocket Agent settings…" also contains the text.
  await desktop.getByRole('menuitem', { name: 'Settings…', exact: true }).click();
  check(
    await waitFor(() => desktop.locator('.settings-section h2', { hasText: /^Hubs$/ }).isVisible(), 15_000),
    'host Settings opened, with this backend’s own "Hubs" section',
  );
  check((await desktop.locator('.settings-section h2', { hasText: 'Config templates' }).count()) === 0, 'no templates card in host Settings');
  await desktop.screenshot({ path: path.join(shots, '5-host-settings-desktop.png') });

  heading('Selecting the Hub tile brings back Hub-only items');
  await desktop.click('.host-rail .host-tile.hub');
  check(await waitFor(() => desktop.isVisible('.hub-page h1')), 'the Hub page again');
  const backMenu = await menuItems(desktop, '.sidebar-head button[aria-label="More"]');
  check(has(backMenu, HUB_ITEMS) && hasNone(backMenu, SERVER_ITEMS), 'Hub-only again', backMenu.join(' | '));

  heading('The phone switcher offers the Hub and the host');
  // The phone was left on `#/hub` by the hostless redirect, and stays there
  // now that a host exists: being on the Hub is a choice the URL records.
  await phone.reload({ waitUntil: 'domcontentloaded' });
  check(await waitFor(() => phone.isVisible('.hub-home .hub-host-card'), 15_000), 'the phone Hub page lists the host');
  await phone.screenshot({ path: path.join(shots, '6-phone-hub-with-host.png'), fullPage: true });
  await phone.click('.home-bar .host-chip.as-button');
  await phone.waitForSelector('.host-sheet');
  const sheet = await phone.$$eval('.host-sheet .sheet-option > span:not(.sheet-option-detail)', (n) =>
    n.map((x) => x.textContent.trim()).filter(Boolean),
  );
  check(sheet[0] === 'Hub' && sheet.includes('All hosts'), 'Hub first, then All hosts and the host', sheet.join(' | '));
  await phone.screenshot({ path: path.join(shots, '7-phone-sheet.png') });
  await phone.click('.host-sheet .sheet-option:has-text("All hosts")');
  check(await waitFor(() => phone.isVisible('.compose-fab')), 'choosing a host view shows the phone home');
  const phoneHostMenu = await menuItems(phone, '.home-bar button[aria-label="More"]');
  check(hasNone(phoneHostMenu, [...HUB_ITEMS, 'Hosts…']), 'phone host menu has no Hub items', phoneHostMenu.join(' | '));

  heading('Stopping the backend takes it off the discovered list');
  backend.kill('SIGTERM');
  const gone = await waitFor(async () => {
    const { body } = await hubApi('/api/hub/discovery');
    return !body?.hosts?.some((h) => h.port === BACKEND_PORT);
  }, 15_000);
  check(gone, 'its mDNS goodbye removed it');
} catch (error) {
  bad('demo crashed', error instanceof Error ? error.stack : String(error));
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nAll PA-110 checks passed.' : `\n${failures} check(s) failed.`);
if (keepShots) console.log(`Screenshots kept in ${shots}`);
process.exit(failures === 0 ? 0 : 1);

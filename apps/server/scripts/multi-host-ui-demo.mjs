#!/usr/bin/env node
/**
 * The multi-host UI, in both viewports (PA-67).
 *
 * The unit suite cannot reach any of this: the web test project runs in
 * `environment: 'node'` with no DOM, so what it covers is the pure host logic
 * (status, poll policy, selection, tab identity) and what a real browser has to
 * cover is the chrome and the streaming behaviour. Specifically, the five
 * acceptance criteria:
 *
 *   1. adding, switching and removing a host works from *both* layouts
 *   2. `#/h/<hostId>/s/<sessionId>` survives a reload
 *   3. a live session on host A keeps streaming while you browse host B
 *   4. one offline host degrades only its own rows
 *   5. no WebSocket is opened per *registered* host — only per attached session
 *
 * Plus the property the whole ticket was shaped around, asserted first: with
 * one host, the screen is the pre-PA-67 screen. No rail, no host heading.
 *
 * The second host deliberately points at a path prefix nothing is proxying, so
 * it resolves as unreachable. That is not a shortcut around a missing Hub — it
 * is the exact case criterion 4 is about, and it is the one multi-host state a
 * single scratch server can produce honestly. Two *reachable* hosts need a
 * reverse proxy in front of two backends (or the Hub from PA-66), which is out
 * of this script's reach; the checks below say so where it matters.
 *
 * Expects a scratch server (PA_BASE, PA_TOKEN) with a throwaway workspace root.
 */
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.PA_BASE ?? 'http://127.0.0.1:8789';
const TOKEN = process.env.PA_TOKEN;
const REPO = new URL('../../../', import.meta.url).pathname;
const SHOTS = path.join(REPO, 'screenshots');

/**
 * The second host's name, and the id the Add dialog derives from it (PA-107:
 * the dialog asks for a name only). Nothing serves `/h/<id>`; that is the point.
 */
const OTHER_LABEL = 'Second box';
const OTHER_ID = 'second-box';
const RENAMED_LABEL = 'Renamed box';

let failures = 0;
let step = 0;
const heading = (t) => console.log(`\n[${++step}] ${t}`);
const check = (cond, label, detail = '') => {
  if (cond) console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

fs.mkdirSync(SHOTS, { recursive: true });

/** Poll until a condition holds. Beats sleeping and hoping React re-rendered. */
async function until(predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      if (await predicate()) return true;
    } catch {
      /* element not there yet */
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 80));
  }
}

async function launch() {
  for (const options of [
    {},
    { channel: 'chrome' },
    { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] },
  ]) {
    try {
      return await chromium.launch(options);
    } catch {
      /* next */
    }
  }
  throw new Error('no usable Chromium');
}

/**
 * One live shell session to look at, and its id for the deep-link check.
 *
 * `shell` because it is always available — no agent CLI needs to be installed
 * for this script to be runnable, which matters for a UI test.
 */
async function seed() {
  let cookie = '';
  const call = async (path, init = {}) => {
    const res = await fetch(BASE + path, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };

  await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
  const { hosts } = await call('/api/hosts');
  const { workspaces } = await call('/api/workspaces');
  const cwd = workspaces[0]?.path;
  if (!cwd) throw new Error('the scratch server has no workspace folders');
  const created = await call('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ agent: 'shell', cwd, cols: 80, rows: 24, title: 'multi-host demo' }),
  });
  return { sessionId: created.id, host: hosts[0] };
}

async function login(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="password"]', TOKEN);
  await page.click('button[type="submit"]');
}

/** Registers the unreachable second host through the UI being tested. */
async function addHostThroughDialog(page) {
  const dialog = '[role="dialog"][aria-label="Add host"]';
  await page.waitForSelector(dialog);
  check(
    (await page.locator(`${dialog} .field span:has-text("Host id")`).count()) === 0,
    'the Add dialog asks for no id (PA-107)',
  );
  await page.fill(`${dialog} .field:nth-of-type(1) input`, OTHER_LABEL);
  const preview = await until(async () =>
    (await page.locator(`${dialog} .host-id-preview`).innerText()).includes(`#/h/${OTHER_ID}/`),
  );
  check(preview, 'and shows the id it derived from the name', `#/h/${OTHER_ID}/`);
  await page.click(`${dialog} button:has-text("Add host")`);
  await until(async () => (await page.locator('[role="dialog"][aria-label="Add host"]').count()) === 0);
}

const { sessionId, host } = await seed();
console.log(`seeded session ${sessionId} on host ${host.name} (${host.id})`);

const browser = await launch();

try {
  // ---------------------------------------------------------------- desktop
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await desktop.newPage();

  // Every full page load and every socket, counted for the two criteria that
  // are about what the app *does not* do.
  let loads = 0;
  page.on('load', () => (loads += 1));
  const sockets = [];
  page.on('websocket', (ws) => sockets.push(ws));

  heading('With one host, the desktop is exactly the pre-PA-67 desktop');
  await login(page);
  await page.waitForSelector('.desktop-shell', { timeout: 15_000 });
  await page.waitForSelector('.sidebar .chat-row');
  check((await page.locator('.host-rail').count()) === 0, 'no host rail with a single host');
  check((await page.locator('.host-group-head').count()) === 0, 'no host heading either');
  check(await page.locator('.host-chip').isVisible(), 'the header chip still names the machine');
  await page.screenshot({ path: path.join(SHOTS, 'multihost-desktop-single.png') });

  heading('A live session opens, and holds exactly one socket');
  await page.locator('.sidebar .chat-row').first().click();
  await page.waitForSelector('.workspace .terminal-page', { timeout: 25_000 });
  await until(async () => sockets.length >= 1);
  const socketsWithOneSession = sockets.length;
  check(socketsWithOneSession === 1, 'one session, one socket', `${socketsWithOneSession}`);

  heading('Adding a host is possible from the desktop layout');
  // The rail is the desktop switcher, but it only exists once there *is*
  // something to switch between — so the way in with a single host is the
  // overflow menu, which both layouts share.
  await page.click('.sidebar-head .round-btn.plain');
  await page.click('[role="menuitem"]:has-text("Hosts…")');
  await page.waitForSelector('.host-sheet');
  await page.click('.host-sheet .sheet-option:has-text("Add host")');
  await addHostThroughDialog(page);

  const railAppeared = await until(async () => (await page.locator('.host-rail').count()) === 1);
  check(railAppeared, 'the rail appears once there is something to switch between');
  const tiles = await page.locator('.host-tile').count();
  check(tiles >= 3, 'with an "All" tile, one per host, and "Add"', `${tiles} tiles`);

  heading('The aggregated home groups by host, without badging any row');
  // "All hosts" is the *list* route; a session pane is still one host's view,
  // which is why this clicks through to it rather than asserting in place.
  await page.click('.host-tile:has-text("All")');
  const grouped = await until(async () => (await page.locator('.host-group-head').count()) === 2);
  check(grouped, 'one heading per host in the all-hosts view');
  check(
    (await page.locator('.sidebar .chat-row .host-name').count()) === 0,
    'and no host label on any chat row',
  );
  await page.screenshot({ path: path.join(SHOTS, 'multihost-desktop-aggregate.png') });

  heading('One offline host degrades only its own rows');
  const problem = page.locator('.host-group-problem');
  const sawProblem = await until(async () => (await problem.count()) === 1, 15_000);
  check(sawProblem, 'the unreachable host says so in its own group');
  if (sawProblem) {
    const text = (await problem.innerText()).trim();
    check(text.length > 0, 'with a legible reason', text.slice(0, 90));
    check(
      text.includes(`/h/${OTHER_ID}`) || /did not answer|could not read/i.test(text),
      'that names where it looked',
    );
  }
  check(
    (await page.locator('.sidebar .chat-row').count()) > 0,
    'while the healthy host still lists its chats',
  );
  check((await page.locator('.spinner').count()) === 0, 'and nothing is left spinning');

  heading('Switching hosts is a state swap, not a page load');
  const loadsBefore = loads;
  await page.click(`.host-tile:has-text("${OTHER_LABEL}")`);
  await until(async () => (await page.locator('.host-tile.active').innerText()).includes(OTHER_LABEL));
  await page.click('.host-tile:has-text("All")');
  await until(async () => (await page.locator('.host-group-head').count()) === 2);
  check(loads === loadsBefore, 'no navigation happened', `${loads - loadsBefore} loads`);

  heading('A live session on host A keeps streaming while host B is on screen');
  const openBefore = sockets.filter((ws) => !ws.isClosed()).length;
  check(openBefore >= 1, 'the session opened in step 2 still holds its socket', `${openBefore} open`);
  await page.click(`.host-tile:has-text("${OTHER_LABEL}")`);
  await until(async () => (await page.locator('.host-tile.active').innerText()).includes(OTHER_LABEL));
  // Give the poll cycle a chance to do something wrong before asserting it did not.
  await new Promise((r) => setTimeout(r, 1500));
  check(
    (await page.locator('.tab-panel').count()) >= 1,
    'the session tab is still mounted while another host is selected',
  );
  check(
    sockets.filter((ws) => !ws.isClosed()).length === openBefore,
    'and its socket was never dropped',
    `${openBefore} open`,
  );

  heading('No WebSocket is opened per registered host');
  check(
    sockets.length === socketsWithOneSession,
    'registering a host and browsing to it opened no further sockets',
    `${sockets.length} total, ${socketsWithOneSession} before the second host existed`,
  );

  heading('A deep link carries the host and survives a reload');
  await page.goto(`${BASE}/#/h/${host.id}/s/${sessionId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.workspace .terminal-page', { timeout: 25_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const survived = await until(
    async () => (await page.locator('.workspace .terminal-page').count()) === 1,
    25_000,
  );
  check(survived, 'the same session is showing after a reload', `#/h/${host.id}/s/${sessionId}`);
  check(
    page.url().includes(`/h/${host.id}/s/${sessionId}`),
    'and the URL still names the host',
    page.url().split('#')[1] ?? '',
  );

  heading('An unknown host is a legible screen, not a silent redirect');
  await page.goto(`${BASE}/#/h/ghost/s/${sessionId}`, { waitUntil: 'domcontentloaded' });
  const namedIt = await until(async () => (await page.locator('.empty code').count()) === 1);
  check(namedIt, 'it says which host is missing');
  if (namedIt) {
    check((await page.locator('.empty code').innerText()).includes('ghost'), 'by name');
  }
  check(
    (await page.locator('.workspace .terminal-page').count()) === 0,
    'and does not quietly open the session on another machine',
  );
  await page.screenshot({ path: path.join(SHOTS, 'multihost-unknown-host.png') });

  heading('The sidebar names which component each version is (PA-107)');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.desktop-shell', { timeout: 15_000 });
  await until(async () => (await page.locator('.host-rail').count()) === 1);
  // Tile 0 is "All"; tile 1 is the host serving this page, the one that answers.
  await page.locator('.host-tile').nth(1).click();
  const versionLabelled = await until(async () =>
    /^Server \S+/.test((await page.locator('.sidebar-version .build-version-line').first().innerText()).trim()),
  );
  check(
    versionLabelled,
    'the first line is the selected host server version',
    (await page.locator('.sidebar-version').innerText()).replace(/\n/g, ' | '),
  );
  const clipped = await page.$$eval('.sidebar-version .build-version-line', (lines) =>
    lines.filter((line) => line.scrollWidth > line.clientWidth).length,
  );
  check(clipped === 0, 'and no line of it is truncated', `${clipped} clipped`);
  check(
    (await page.locator('.sidebar-version').getAttribute('title'))?.includes('Web UI') === true,
    'with the web bundle build in the tooltip',
  );

  heading('A renamed host shows its new name everywhere, with no reload (PA-107)');
  const loadsBeforeRename = loads;
  await page.click('.sidebar-head .round-btn.plain');
  await page.click('[role="menuitem"]:has-text("Hosts…")');
  await page.waitForSelector('.host-sheet');
  await page.click(`.host-sheet [aria-label="Edit ${OTHER_LABEL}"]`);
  await page.waitForSelector('[role="dialog"][aria-label="Edit host"]');
  await page.fill('[role="dialog"][aria-label="Edit host"] .field:nth-of-type(1) input', RENAMED_LABEL);
  await page.click('[role="dialog"][aria-label="Edit host"] button:has-text("Save")');
  await until(async () => (await page.locator('[role="dialog"][aria-label="Edit host"]').count()) === 0);
  if ((await page.locator('.host-sheet').count()) > 0) await page.click('.host-sheet .sheet-cancel');
  const tileRenamed = await until(
    async () => (await page.locator(`.host-tile:has-text("${RENAMED_LABEL}")`).count()) === 1,
  );
  check(tileRenamed, 'the rail tile shows the new name');
  await page.click('.host-tile:has-text("All")');
  const headingRenamed = await until(
    async () => (await page.locator(`.host-group-head:has-text("${RENAMED_LABEL}")`).count()) === 1,
  );
  check(headingRenamed, 'so does its group heading');
  await page.click(`.host-tile:has-text("${RENAMED_LABEL}")`);
  const chipRenamed = await until(async () =>
    (await page.locator('.sidebar-brand .host-chip').innerText()).includes(RENAMED_LABEL),
  );
  check(chipRenamed, 'and the header chip');
  check(page.url().includes(`/h/${OTHER_ID}`), 'while the id in the URL is unchanged', page.url().split('#')[1] ?? '');
  check(loads === loadsBeforeRename, 'with no page load', `${loads - loadsBeforeRename}`);
  await page.screenshot({ path: path.join(SHOTS, 'multihost-desktop-renamed.png') });

  heading('Removing a host works from the desktop layout');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.desktop-shell', { timeout: 15_000 });
  await until(async () => (await page.locator('.host-rail').count()) === 1);
  await page.click('.sidebar-head .round-btn.plain');
  await page.click('[role="menuitem"]:has-text("Hosts…")');
  await page.waitForSelector('.host-sheet');
  await page.click('.host-sheet .host-sheet-remove');
  await page.click('.host-sheet .sheet-cancel');
  const railGone = await until(async () => (await page.locator('.host-rail').count()) === 0);
  check(railGone, 'the rail disappears again with one host left');
  check(
    (await page.locator('.host-group-head').count()) === 0,
    'and so does the host heading',
  );
  await desktop.close();

  // ------------------------------------------------------------------ phone
  heading('With one host, the phone screen is exactly the pre-PA-67 screen');
  const phone = await browser.newContext({ ...devices['iPhone 13'] });
  const phonePage = await phone.newPage();
  let phoneLoads = 0;
  phonePage.on('load', () => (phoneLoads += 1));
  await login(phonePage);
  await phonePage.waitForSelector('.projects-page', { timeout: 15_000 });
  await phonePage.waitForSelector('.chat-row');
  check((await phonePage.locator('.host-group-head').count()) === 0, 'no host heading');
  check((await phonePage.locator('.host-rail').count()) === 0, 'and no rail on a phone, ever');
  await phonePage.screenshot({ path: path.join(SHOTS, 'multihost-phone-single.png') });

  heading('The header chip is the switcher, and it opens a bottom sheet');
  await phonePage.click('.host-chip');
  const sheetOpened = await until(async () => (await phonePage.locator('.host-sheet').count()) === 1);
  check(sheetOpened, 'tapping the chip opens the host sheet');
  check(
    (await phonePage.locator('.host-sheet .sheet-option').count()) >= 2,
    'listing "All hosts" and this machine',
  );
  await phonePage.screenshot({ path: path.join(SHOTS, 'multihost-phone-sheet.png') });

  heading('Adding a host works from the phone layout');
  await phonePage.click('.host-sheet .sheet-option:has-text("Add host")');
  await addHostThroughDialog(phonePage);
  const phoneGroups = await until(
    async () => (await phonePage.locator('.host-group-head').count()) === 2,
  );
  check(phoneGroups, 'both hosts are now grouped on the home screen');
  const phoneProblem = await until(
    async () => (await phonePage.locator('.host-group-problem').count()) === 1,
    15_000,
  );
  check(phoneProblem, 'and the unreachable one explains itself here too');
  await phonePage.screenshot({ path: path.join(SHOTS, 'multihost-phone-aggregate.png') });

  heading('Switching hosts on a phone is also a state swap');
  const phoneLoadsBefore = phoneLoads;
  await phonePage.click('.host-chip');
  await until(async () => (await phonePage.locator('.host-sheet').count()) === 1);
  await phonePage.click(`.host-sheet .sheet-option:has-text("${OTHER_LABEL}")`);
  await until(async () => (await phonePage.locator('.host-sheet').count()) === 0);
  check(
    (await phonePage.locator('.host-group-head').count()) === 1,
    'the view narrows to the chosen host',
  );
  check(phoneLoads === phoneLoadsBefore, 'with no page load', `${phoneLoads - phoneLoadsBefore}`);

  heading('Removing a host works from the phone layout');
  await phonePage.click('.host-chip');
  await until(async () => (await phonePage.locator('.host-sheet').count()) === 1);
  await phonePage.click('.host-sheet-remove');
  const backToOne = await until(
    async () => (await phonePage.locator('.host-sheet .host-sheet-row').count()) === 1,
  );
  check(backToOne, 'the row goes, leaving the host that served the app');
  await phonePage.click('.host-sheet .sheet-cancel');
  const headingsGone = await until(
    async () => (await phonePage.locator('.host-group-head').count()) === 0,
  );
  check(headingsGone, 'and the heading disappears with it');
  await phone.close();
} catch (err) {
  failures++;
  console.error('\nFATAL:', err);
} finally {
  await browser.close();
  console.log(
    failures === 0
      ? `\n✅ all ${step} steps passed — screenshots in screenshots/`
      : `\n❌ ${failures} check(s) failed across ${step} steps`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

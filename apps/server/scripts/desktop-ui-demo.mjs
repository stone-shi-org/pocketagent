#!/usr/bin/env node
/**
 * The desktop layout, in a desktop-sized browser.
 *
 * Checks the thing width actually buys: the chat list stays on screen while a
 * session is open, so switching chats is a click rather than a round trip
 * through the home screen. Also checks that the layout is chosen by viewport
 * and pointer rather than by user agent — narrow the window and the phone
 * layout comes back.
 */
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.PA_BASE ?? 'http://127.0.0.1:8791';
const TOKEN = process.env.PA_TOKEN;
const EXTRA_DIR = process.env.PA_EXTRA_DIR ?? '/tmp/pa-desk-extra';
const REPO = new URL('../../../', import.meta.url).pathname;
const SHOTS = path.join(REPO, 'screenshots');

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

async function until(predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      if (await predicate()) return true;
    } catch {
      /* not yet */
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

const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

try {
  heading('A desktop browser gets the two-pane shell');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="password"]', TOKEN);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.desktop-shell', { timeout: 15_000 });
  check(await page.locator('.sidebar').isVisible(), 'sidebar present');
  check(await page.locator('.workspace').isVisible(), 'main pane present');
  check(
    (await page.locator('.projects-page').count()) === 0,
    'and not the phone screen',
  );

  heading('It opens on a welcome pane, not a blank one');
  check(await page.locator('.welcome').isVisible(), 'welcome pane shown');
  check(
    (await page.locator('.welcome h2').innerText()).length > 0,
    'with something to do next',
    await page.locator('.welcome h2').innerText(),
  );
  await page.waitForSelector('.sidebar .chat-row');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-welcome.png') });

  heading('Opening a chat keeps the list on screen');
  const sidebarChats = await page.locator('.sidebar .chat-row').count();
  check(sidebarChats >= 2, 'several chats listed', `${sidebarChats}`);
  await page.locator('.sidebar .chat-row').first().click();
  await page.waitForSelector('.workspace .terminal-page', { timeout: 25_000 });
  check(await page.locator('.sidebar').isVisible(), 'the sidebar is still there');
  check(
    (await page.locator('.sidebar .chat-row').count()) === sidebarChats,
    'with the same chats',
  );

  heading('The open chat is marked in the list');
  check(
    (await page.locator('.sidebar .chat-row.active').count()) === 1,
    'exactly one row is highlighted',
  );
  await page.screenshot({ path: path.join(SHOTS, 'desktop-session.png') });

  heading('Switching chats is one click');
  const second = page.locator('.sidebar .chat-row').nth(1);
  const secondTitle = (await second.innerText()).trim();
  await second.click();
  const switched = await until(async () => {
    const active = await page.locator('.sidebar .chat-row.active').innerText();
    return active.trim() === secondTitle;
  }, 20_000);
  check(switched, 'the highlight follows', secondTitle);
  check(
    await page.locator('.workspace .terminal-page').isVisible(),
    'and the pane shows the other session',
  );

  heading('The soft-keyboard bar is not shown to a real keyboard');
  check(
    !(await page.locator('.workspace .keybar').isVisible().catch(() => false)),
    'key bar hidden on desktop',
  );

  heading('The composer opens in the pane, beside the list');
  await page.click('.new-chat-btn');
  await page.waitForSelector('.workspace .composer-page');
  check(await page.locator('.sidebar').isVisible(), 'list still visible while composing');
  // The rows appear only once the workspace, agent and conversation lists have
  // all answered; counting before that races the spinner.
  await until(async () => (await page.locator('.selector-row').count()) === 4, 15_000);
  check((await page.locator('.selector-row').count()) === 4, 'four selector rows');
  await page.screenshot({ path: path.join(SHOTS, 'desktop-composer.png') });

  heading('A folder can be added from the app');
  const projectsAtStart = await page.locator('.sidebar .project').count();
  await page.click('.sidebar .add-project');
  await page.waitForSelector('[role="dialog"][aria-label="Add a project"]');

  await page.click('[role="tab"]:has-text("Browse")');
  await page.waitForSelector('.browse-bar');
  check(
    (await page.locator('.browse-path').innerText()).trim().length > 0,
    'the picker lists directories on the host, not on this device',
    (await page.locator('.browse-path').innerText()).trim(),
  );

  // Add a folder that no configuration ever mentioned. Driven through the API
  // rather than by clicking through the tree, because which directories exist
  // above the scratch dir is not this test's business.
  const added = await page.evaluate(async (path) => {
    const res = await fetch('/api/workspaces/add', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    return res.ok;
  }, EXTRA_DIR);
  check(added, 'a folder outside any configured root was accepted', EXTRA_DIR);

  await page.click('[role="dialog"][aria-label="Add a project"] button:has-text("Close")');
  await until(async () => (await page.locator('[role="dialog"]').count()) === 0);

  const grew = await until(
    async () => (await page.locator('.sidebar .project').count()) > projectsAtStart,
    15_000,
  );
  check(grew, 'and it appears as a project');

  heading('Subdirectories are not projects');
  const labels = await page.locator('.sidebar .project-label').allTextContents();
  check(
    !labels.some((l) => ['venv', 'node_modules', 'deep', '__pycache__'].includes(l.trim())),
    'no venv or node_modules masquerading as work',
    labels.join(', '),
  );

  heading('The composer offers what is already on the host');
  // The step above navigated back to the list; open the composer again.
  await page.click('.new-chat-btn');
  await page.waitForSelector('.workspace .composer-page');
  await until(async () => (await page.locator('.selector-row').count()) === 4, 15_000);
  const chatRow = () => page.locator('.selector-row').nth(3);
  await chatRow().click();
  await page.waitForSelector('.sheet');
  const options = await page.locator('.sheet-option').allTextContents();
  check(options.length > 1, 'existing chats are offered, not just "New chat"', `${options.length} options`);
  check(
    options.some((o) => /running now/.test(o)),
    'including ones running right now',
  );
  check(
    options.some((o) => /api-server|web-client|notes/.test(o)),
    'from subdirectories of the chosen workspace',
  );

  heading('Picking a running chat joins it instead of starting a second');
  const sessionsBefore = await page.evaluate(async () =>
    (await (await fetch('/api/sessions', { credentials: 'same-origin' })).json()).sessions.length,
  );
  const runningOption = page.locator('.sheet-option').filter({ hasText: 'running now' }).first();
  const runningTitle = (await runningOption.locator('.sheet-option-label').innerText()).trim();
  await runningOption.click();
  await until(async () =>
    (await page.locator('.selector-value').nth(3).innerText()).includes(runningTitle),
  );
  check(
    /Already running/.test(await page.locator('.composer-note').innerText()),
    'the composer says so before you send',
  );

  await page.fill('.composer-input', 'echo JOINED_EXISTING');
  await until(async () => !(await page.locator('.send-btn').isDisabled()));
  await page.click('.send-btn');
  await page.waitForSelector('.workspace .terminal-page', { timeout: 25_000 });

  const sessionsAfter = await page.evaluate(async () =>
    (await (await fetch('/api/sessions', { credentials: 'same-origin' })).json()).sessions.length,
  );
  check(sessionsAfter === sessionsBefore, 'no new session was created', `${sessionsBefore} -> ${sessionsAfter}`);
  check(
    (await page.locator('.workspace .topbar .title strong').innerText()).trim() === runningTitle,
    'and we landed on the one we picked',
    runningTitle,
  );
  check(
    await until(async () =>
      (await page.locator('.workspace .xterm-screen').innerText()).includes('JOINED_EXISTING'),
      20_000,
    ),
    'the typed prompt went to that running session',
  );

  heading('A finished chat can be removed from the list');
  // Stop one first: the server refuses to forget a record whose process is
  // still running, which would leave it alive with no way back to it.
  const removable = () => page.locator('.sidebar .chat-line').filter({ has: page.locator('.chat-remove') });
  const removableBefore = await removable().count();

  await page.locator('.sidebar .chat-row').first().click();
  await page.waitForSelector('.workspace .terminal-page', { timeout: 25_000 });
  page.once('dialog', (d) => void d.accept());
  await page.click('.workspace button:has-text("Stop")');

  // The stopped chat does not jump to the top — the list is ordered by activity,
  // not by what changed last — so look for the control anywhere.
  const wentQuiet = await until(
    async () => (await removable().count()) > removableBefore,
    20_000,
  );
  check(wentQuiet, 'a remove control appears once a chat is finished');
  check(
    (await page.locator('.sidebar .chat-line.live .chat-remove').count()) === 0,
    'and never on a running one',
  );

  const before = await page.locator('.sidebar .chat-row').count();
  const doomed = (await removable().first().locator('.chat-title').innerText()).trim();
  await removable().first().locator('.chat-remove').click();
  const removed = await until(
    async () => (await page.locator('.sidebar .chat-row').count()) === before - 1,
    15_000,
  );
  check(removed, 'the row is gone', doomed);

  heading('A folder can be removed again');
  const projectName = (await page.locator('.sidebar .project-label').first().innerText()).trim();
  const beforeRemove = await page.locator('.sidebar .project').count();
  await page.locator('.sidebar .project-head').first().locator('button[aria-label^="Options"]').click();
  await page.waitForSelector('.project-menu');
  // An added folder is removed outright; only a directory something merely ran
  // in is offered as "hide", since that one is not the user's to remove.
  check(
    (await page.locator('.project-menu button:has-text("Remove this folder")').count()) === 1,
    'the menu offers to remove the folder',
  );
  await page.click('.project-menu button:has-text("Remove this folder")');
  const shrank = await until(
    async () => (await page.locator('.sidebar .project').count()) === beforeRemove - 1,
    15_000,
  );
  check(shrank, 'the folder is gone from the list', projectName);

  heading('Removing a folder does not delete anything');
  const stillThere = await page.evaluate(async (path) => {
    const res = await fetch(`/api/browse?path=${encodeURIComponent(path)}`, {
      credentials: 'same-origin',
    });
    return res.ok;
  }, EXTRA_DIR);
  check(stillThere, 'the directory is still on disk and still browsable');

  await page.locator('.sidebar-head button[aria-label="More"]').click();
  await page.click('.menu button:has-text("Hidden projects")');
  await page.waitForSelector('[role="dialog"][aria-label="Hidden projects"]');
  check(
    /Nothing was deleted/i.test(await page.locator('[role="dialog"]').innerText()),
    'and the hidden-projects dialog says as much',
  );
  await page.click('[role="dialog"] button:has-text("Close")');
  await until(async () => (await page.locator('[role="dialog"]').count()) === 0);

  heading('Narrowing the window returns the phone layout');
  // The point of deciding on viewport rather than user agent: same browser,
  // different layout, no reload.
  await page.setViewportSize({ width: 620, height: 900 });
  const wentCompact = await until(async () => (await page.locator('.desktop-shell').count()) === 0);
  check(wentCompact, 'two-pane shell gone');
  await page.setViewportSize({ width: 1440, height: 900 });
  const cameBack = await until(async () => (await page.locator('.desktop-shell').count()) === 1);
  check(cameBack, 'and it comes back when widened');

  heading('A touch device stays on the phone layout at the same width');
  const touch = await browser.newContext({ ...devices['iPad Pro 11 landscape'] });
  const touchPage = await touch.newPage();
  await touchPage.goto(BASE, { waitUntil: 'domcontentloaded' });
  await touchPage.fill('input[type="password"]', TOKEN);
  await touchPage.click('button[type="submit"]');
  await touchPage.waitForSelector('.projects-page, .desktop-shell', { timeout: 15_000 });
  check(
    (await touchPage.locator('.desktop-shell').count()) === 0,
    'coarse pointer gets the compact layout despite the width',
    `${touchPage.viewportSize().width}px, touch`,
  );
  await touch.close();
} catch (err) {
  failures++;
  console.error('\nFATAL:', err);
  await page.screenshot({ path: path.join(SHOTS, 'desktop-failure.png') }).catch(() => {});
} finally {
  await browser.close();
  console.log(
    failures === 0
      ? `\n✅ all ${step} steps passed — screenshots in screenshots/`
      : `\n❌ ${failures} check(s) failed across ${step} steps`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

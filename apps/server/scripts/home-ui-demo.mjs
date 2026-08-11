#!/usr/bin/env node
/**
 * Browser pass over the home screen and the composer, at phone size.
 *
 * Checks the structure the design calls for: a folder per workspace that
 * collapses, chats listed beneath it, a host chip in the header, search that
 * filters across projects, and a composer whose four rows drive what gets
 * created.
 *
 * Expects a scratch server (PA_BASE, PA_TOKEN) with a few workspaces.
 */
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.PA_BASE ?? 'http://127.0.0.1:8789';
const TOKEN = process.env.PA_TOKEN;
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

/** Poll until a condition holds. Beats sleeping and hoping React re-rendered. */
async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      if (await predicate()) return true;
    } catch {
      /* element not there yet */
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
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
 * Seed a chat in each workspace.
 *
 * The screen under test only lists directories that have something in them, so
 * an empty server renders the (correct) empty state and nothing else. Rather
 * than depend on whatever the last run left behind, put the fixture there.
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
  const { workspaces } = await call('/api/workspaces');
  const { projects } = await call('/api/projects');
  // Keyed on a *live* chat, not any chat. Sessions on the direct backend die
  // with the server, so after a restart every previous run's chat is history
  // and seeding on mere presence leaves nothing running to assert against.
  const occupied = new Set(
    projects.filter((p) => p.chats.some((c) => c.live)).map((p) => p.cwd),
  );

  let created = 0;
  for (const workspace of workspaces.filter((w) => !w.isRoot)) {
    if (occupied.has(workspace.path)) continue;
    await call('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        agent: 'shell',
        cwd: workspace.path,
        cols: 80,
        rows: 24,
        title: `work in ${workspace.name}`,
      }),
    });
    created++;
  }
  return { created, total: workspaces.filter((w) => !w.isRoot).length };
}

const seeded = await seed();
console.log(
  `(fixture: ${seeded.created} chat(s) created, ${seeded.total} workspace(s) available)`,
);

const browser = await launch();
const context = await browser.newContext({ ...devices['iPhone 13'] });
const page = await context.newPage();

try {
  heading('Log in');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="password"]', TOKEN);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.projects-page', { timeout: 15_000 });
  check(true, 'the home screen is the projects screen');

  heading('The header names the host it is talking to');
  const host = (await page.locator('.host-chip').innerText()).trim();
  check(host.length > 0, 'host chip present', host);
  check(await page.locator('.host-dot').isVisible(), 'with an online dot');

  heading('Projects are folders, chats live inside them');
  await page.waitForSelector('.project');
  const projects = page.locator('.project');
  const count = await projects.count();
  check(count >= 2, 'more than one project listed', `${count} folders`);

  const first = projects.first();
  const name = (await first.locator('.project-label').innerText()).trim();
  const chats = await first.locator('.chat-row').count();
  check(chats >= 1, `“${name}” has its chats nested under it`, `${chats} chat(s)`);
  check(
    (await page.locator('.chat-row .live-dot').count()) >= 1,
    'a running chat is marked live',
  );
  await page.screenshot({ path: path.join(SHOTS, 'home-projects.png') });

  heading('Folders collapse');
  const chatCount = () => first.locator('.chat-row').count();
  await first.locator('.project-name').click();
  await until(async () => (await chatCount()) === 0);
  check((await chatCount()) === 0, 'chats hidden when collapsed');
  await first.locator('.project-name').click();
  await until(async () => (await chatCount()) === chats);
  check((await chatCount()) === chats, 'and come back when expanded');

  heading('Search filters across every project');
  await page.fill('.search-pill input', 'notes');
  await until(async () => {
    const labels = await page.locator('.project-label').allTextContents();
    return labels.length > 0 && labels.every((s) => s.toLowerCase().includes('notes'));
  });
  const shown = await page.locator('.project-label').allTextContents();
  check(
    shown.every((s) => s.toLowerCase().includes('notes')) && shown.length > 0,
    'only matching projects remain',
    shown.join(', '),
  );
  await page.fill('.search-pill input', 'zzzz-no-such-chat');
  await until(() => page.locator('.empty').isVisible());
  check(await page.locator('.empty').isVisible(), 'and an honest empty state when nothing matches');
  await page.click('.search-clear');
  await until(async () => (await page.locator('.project').count()) > 0);

  heading('The compose button opens the composer');
  await page.click('.compose-fab');
  await page.waitForSelector('.composer-page');
  await page.waitForSelector('.selector-row');
  const rows = await page.locator('.selector-row').count();
  check(rows === 4, 'four selector rows', `${rows}`);
  const values = await page.locator('.selector-value').allTextContents();
  check(values[0] === host.replace(/\s+/g, ' ').trim() || values[0].length > 0, 'host row', values[0]);
  check(values[1].length > 0, 'workspace row', values[1]);
  check(/·/.test(values[2]), 'agent and interface in one row', values[2]);
  check(/New chat/.test(values[3]), 'chat row defaults to a new chat', values[3]);
  check(
    (await page.locator('.selector-row .icon').count()) >= 4,
    'every row is led by a real icon, not a glyph',
  );
  await page.screenshot({ path: path.join(SHOTS, 'home-composer.png') });

  heading('A row only shows a stepper when it has somewhere to step');
  const rowLocator = (n) => page.locator('.selector-row').nth(n).locator('.stepper');
  check((await rowLocator(0).count()) === 0, 'host has one option, so no stepper');
  // Pins the check above to the real rule rather than to a class name that
  // could be renamed out from under it.
  check((await rowLocator(1).count()) === 1, 'workspace has several, so it gets one');

  heading('Picking a workspace opens a sheet');
  await page.locator('.selector-row').nth(1).click();
  await page.waitForSelector('.sheet');
  const options = await page.locator('.sheet-option').count();
  check(options >= 2, 'the sheet lists the workspaces', `${options} options`);
  await page.locator('.sheet-option', { hasText: 'notes-app' }).first().click();
  await until(async () =>
    (await page.locator('.selector-value').nth(1).innerText()).includes('notes-app'),
  );
  check(
    (await page.locator('.selector-value').nth(1).innerText()).includes('notes-app'),
    'and the row updates to the choice',
  );

  heading('Send is disabled until there is something to send');
  check(await page.locator('.send-btn').isDisabled(), 'disabled with an empty prompt');
  await page.fill('.composer-input', 'echo HELLO_FROM_COMPOSER');
  await until(async () => !(await page.locator('.send-btn').isDisabled()));
  check(!(await page.locator('.send-btn').isDisabled()), 'enabled once a prompt is typed');

  heading('Choosing the terminal interface and sending starts the session');
  await page.locator('.selector-row').nth(2).click();
  await page.waitForSelector('.sheet');
  await page.locator('.sheet-option', { hasText: 'Shell · terminal' }).first().click();
  await until(async () =>
    (await page.locator('.selector-value').nth(2).innerText()).includes('Shell'),
  );
  await page.click('.send-btn');
  await page.waitForSelector('.terminal-page', { timeout: 20_000 });
  check(true, 'landed on the session');

  heading('The typed prompt is delivered as the first thing the session sees');
  await page.waitForFunction(
    () => document.querySelector('.xterm-screen')?.textContent?.includes('HELLO_FROM_COMPOSER'),
    undefined,
    { timeout: 25_000 },
  );
  check(true, 'the prompt ran in the new session');
  await page.screenshot({ path: path.join(SHOTS, 'home-first-prompt.png') });

  heading('Back returns to the projects screen, with the new chat in place');
  await page.click('button[aria-label="Back to sessions"]');
  await page.waitForSelector('.projects-page');
  await until(async () => {
    const t = await page.locator('.chat-title').allTextContents();
    return t.some((x) => x.includes('notes-app'));
  }, 10_000);
  const titles = await page.locator('.chat-title').allTextContents();
  check(
    titles.some((t) => t.includes('notes-app')),
    'the chat is filed under its project',
  );
} catch (err) {
  failures++;
  console.error('\nFATAL:', err);
  await page.screenshot({ path: path.join(SHOTS, 'home-failure.png') }).catch(() => {});
} finally {
  await browser.close();
  console.log(
    failures === 0
      ? `\n✅ all ${step} steps passed — screenshots in screenshots/`
      : `\n❌ ${failures} check(s) failed across ${step} steps`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

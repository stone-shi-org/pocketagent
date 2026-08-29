#!/usr/bin/env node
/**
 * Browser pass over scheduled jobs, at phone size.
 *
 * The unit suite covers the schedule solver and the scheduler's policies, but
 * not the things only a browser can answer: that the overflow menu reaches the
 * page, that the preset picker round-trips into a live "next runs" preview,
 * that a raw cron expression shows its own error text, that the approvals
 * warning is actually visible when a job is about to run bypassed, and that a
 * job shows up in the project tree with its clock badge before it has ever run.
 *
 * Expects a *scratch* server (PA_BASE, PA_TOKEN) with a throwaway workspace
 * root — it creates and deletes jobs.
 */
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.PA_BASE ?? 'http://127.0.0.1:8791';
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

async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      if (await predicate()) return true;
    } catch {
      /* not there yet */
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

/** Clear out jobs from a previous run so assertions are about this one. */
async function reset() {
  let cookie = '';
  const call = async (p, init = {}) => {
    const res = await fetch(BASE + p, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        origin: BASE,
      },
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
  await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
  const { jobs } = await call('/api/cron/jobs');
  for (const job of jobs ?? []) {
    await call(`/api/cron/jobs/${job.id}`, { method: 'DELETE' });
  }
  const { workspaces } = await call('/api/workspaces');
  return workspaces?.[0]?.path ?? null;
}

const root = await reset();
if (!TOKEN) {
  console.error('PA_TOKEN is required.');
  process.exit(1);
}

const browser = await launch();
const context = await browser.newContext({ ...devices['iPhone 13'], hasTouch: true });
const page = await context.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`  [console] ${m.text()}`);
});

await page.goto(BASE);
await page.fill('input[type="password"]', TOKEN);
await page.click('button[type="submit"]');
await until(() => page.locator('.home-bar').isVisible());

// -- 1. Reaching the page from the overflow menu ----------------------------
heading('Cron jobs is reachable from the "…" menu');
await page.click('.home-bar .round-btn[aria-label="More"]');
await until(() => page.locator('.menu').isVisible());
const cronItem = page.locator('.menu button', { hasText: 'Cron jobs' });
check(await cronItem.isVisible(), 'menu has a "Cron jobs…" item');
await cronItem.click();
check(
  await until(() => page.locator('.cron-page').isVisible()),
  'the jobs page opens',
);
check(
  (await page.locator('.cron-empty').textContent())?.includes('Nothing scheduled'),
  'empty state explains what a job is',
);
await page.screenshot({ path: path.join(SHOTS, 'cron-01-empty.png') });

// -- 2. The editor, preset mode --------------------------------------------
heading('Preset picker drives a live preview');
await page.click('.cron-new');
check(await until(() => page.locator('.cron-editor').isVisible()), 'editor opens');

await page.fill('.cron-field input.settings-input', 'Nightly review');
// Weekly, so the weekday chips appear.
await page.click('.cron-chips .chip:has-text("Weekly")');
check(
  await until(async () => (await page.locator('.cron-chips .chip:has-text("Mon")').count()) > 0),
  'weekly reveals weekday chips',
);
await page.click('.cron-chips .chip:has-text("Wed")');
await page.click('.cron-chips .chip:has-text("Fri")');

const previewItems = page.locator('.cron-preview li');
check(await until(async () => (await previewItems.count()) === 3), 'shows the next 3 runs');
const firstPreview = await previewItems.first().textContent();
check(/\(in /.test(firstPreview ?? ''), 'preview carries a countdown', firstPreview?.trim());

await page.fill('.cron-prompt', 'Review the commits from yesterday.');
await page.screenshot({ path: path.join(SHOTS, 'cron-02-editor-preset.png'), fullPage: true });

// -- 3. The approvals warning is visible, not buried -----------------------
heading('Skip-permissions default is ON and says so');
const skipToggle = page.locator('input[aria-label="Skip tool approvals"]');
check(await skipToggle.isChecked(), 'defaults to on (a scheduled run is unattended)');
check(
  await page.locator('.warn-callout').isVisible(),
  'a visible warning explains what that means',
);
await skipToggle.uncheck();
check(
  await until(async () =>
    ((await page.locator('.cron-note').allTextContents()).join(' ')).includes('will wait'),
  ),
  'turning it off explains the run will park instead',
);
await skipToggle.check();

// -- 4. Advanced mode validates ------------------------------------------
heading('Raw cron expression is validated inline');
await page.click('.cron-tabs button:has-text("Advanced")');
const exprInput = page.locator('.settings-input.mono');
check(
  (await exprInput.inputValue()).length > 0,
  'seeded from the picker rather than blank',
  await exprInput.inputValue(),
);
await exprInput.fill('0 0 * *');
check(
  await until(() => page.locator('.error-box').isVisible()),
  'a 4-field expression is rejected with a message',
);
await exprInput.fill('*/15 9-17 * * 1-5');
check(
  await until(async () => (await page.locator('.cron-preview li').count()) === 3),
  'a valid expression previews again',
);
await page.screenshot({ path: path.join(SHOTS, 'cron-03-editor-advanced.png'), fullPage: true });

// -- 5. Save, and see it listed -------------------------------------------
heading('Saving lands on the list');
await page.click('.cron-save');
check(await until(() => page.locator('.cron-row').first().isVisible()), 'the job is listed');
const rowText = await page.locator('.cron-row').first().textContent();
check(/Next run in/.test(rowText ?? ''), 'row shows when it next runs');
check(
  await page.locator('.cron-row .cron-shield').first().isVisible(),
  'the bypass badge persists on the row, not just at creation',
);
await page.screenshot({ path: path.join(SHOTS, 'cron-04-list.png') });

// -- 6. Pausing ------------------------------------------------------------
heading('Pausing a job');
await page.locator('.cron-actions .switch input').first().uncheck();
check(
  await until(async () => /Paused/.test((await page.locator('.cron-row').first().textContent()) ?? '')),
  'row reads as paused',
);
await page.locator('.cron-actions .switch input').first().check();

// -- 7. The project tree ---------------------------------------------------
heading('The job appears in the project tree with a clock badge');
await page.goto(`${BASE}/#/`);
await until(() => page.locator('.project').first().isVisible());
// Expand every project so a nested one is not hidden behind a collapse.
const jobRow = page.locator('.cron-job-row');
check(
  await until(async () => (await jobRow.count()) > 0, 8000),
  'a cron row is rendered among the projects',
  root ? `workspace ${root}` : '',
);
check(
  (await page.locator('.cron-job-row .cron-badge-icon').count()) > 0,
  'the row carries the clock icon overlay',
);
await page.screenshot({ path: path.join(SHOTS, 'cron-05-project-tree.png'), fullPage: true });

heading('Tapping the row opens its editor');
await jobRow.first().click();
check(
  await until(() => page.locator('.cron-editor').isVisible()),
  'the editor opens from the tree',
);
check(
  (await page.locator('.cron-field input.settings-input').first().inputValue()) === 'Nightly review',
  'and it is the job that was tapped',
);

// Which editor a job re-opens in has to survive a round trip through the
// server: this one was saved from the Advanced field, so it is genuinely no
// longer "weekly at 09:00" and must not re-open in the picker pretending to be.
heading('A job re-opens in the editor it was saved from');
check(
  (await page
    .locator('.cron-tabs button:has-text("Advanced")')
    .getAttribute('aria-selected')) === 'true',
  'saved as an expression, re-opened on Advanced',
);
check(
  (await page.locator('.settings-input.mono').inputValue()) === '*/15 9-17 * * 1-5',
  'with the expression that was typed',
);

// And a preset-built job round-trips back into the picker.
heading('A preset job re-opens in the picker');
await page.goto(`${BASE}/#/cron`);
await until(() => page.locator('.cron-page').isVisible());
await page.click('.cron-new');
await until(() => page.locator('.cron-editor').isVisible());
await page.fill('.cron-field input.settings-input', 'Daily standup');
await page.click('.cron-chips .chip:has-text("Daily")');
await page.fill('.cron-prompt', 'Summarise open PRs.');
await page.click('.cron-save');
await until(async () => (await page.locator('.cron-row').count()) === 2);
await page.locator('.cron-main', { hasText: 'Daily standup' }).click();
check(
  await until(
    async () =>
      (await page
        .locator('.cron-tabs button:has-text("Simple")')
        .getAttribute('aria-selected')) === 'true',
  ),
  'a preset job re-opens on Simple, not dumped into raw cron',
);
check(
  await page.locator('.cron-chips .chip.active:has-text("Daily")').isVisible(),
  'with the preset it was built with pre-selected',
);

console.log(
  failures === 0
    ? `\n✅ all checks passed — screenshots in ${SHOTS}`
    : `\n❌ ${failures} check(s) failed`,
);

await browser.close();
process.exit(failures === 0 ? 0 : 1);

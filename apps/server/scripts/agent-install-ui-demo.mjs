#!/usr/bin/env node
/**
 * The agent setup dialog, in a real browser, at a phone viewport (PA-68).
 *
 * The unit suite covers every rule in `agent/agent-setup.ts` and every route
 * behaviour in `agent-install.test.ts`, but neither can see the two things
 * that actually decide whether this feature is usable: that four states are
 * *distinguishable* on a 390px screen, and that a slow install streams
 * visibly instead of sitting behind a silent spinner. The `web` vitest project
 * has no DOM at all, so this is the only level at which either can be checked.
 *
 * **Point this at a scratch server.** It installs nothing real — the catalog
 * ids it exercises are refused before any package is fetched, and the one
 * install it does run is driven against whatever the host already has — but it
 * logs in, opens Settings and reads the live agent list, so it wants a
 * throwaway `POCKETAGENT_DATA_DIR` like every other `PA_BASE` demo.
 *
 *   PA_TOKEN=... PA_BASE=http://127.0.0.1:8793 pnpm demo:agent-install-ui
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.PA_BASE ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.PA_TOKEN;
const REPO = new URL('../../../', import.meta.url).pathname;
const SHOTS = path.join(REPO, 'screenshots');

if (!TOKEN) {
  console.error('PA_TOKEN is required (the scratch server’s POCKETAGENT_AUTH_TOKEN).');
  process.exit(2);
}

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

async function until(predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      if (await predicate()) return true;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
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
// iPhone-ish. The whole premise of this feature is an operator bringing up a
// backend from a phone, so the dialog has to be legible at this width.
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  hasTouch: true,
});
const page = await context.newPage();

try {
  heading('Sign in and open Settings');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="password"]', TOKEN);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.projects-page, .desktop-shell', { timeout: 15_000 });
  await page.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.settings-page', { timeout: 15_000 });

  heading('The Coding Agents section reports a state per agent, not just presence');
  const section = page
    .locator('.settings-section')
    .filter({ has: page.locator('h2', { hasText: 'Coding Agents' }) });
  check((await section.count()) === 1, 'the section is there');
  await until(async () => (await section.locator('.planner-model-row').count()) > 0, 15_000);
  const rows = await section.locator('.planner-model-row').count();
  check(rows > 0, 'one row per coding agent', `${rows}`);

  const badges = await section.locator('.settings-badge').allInnerTexts();
  check(badges.length === rows, 'every row carries a state badge', badges.join(', '));
  // The point of the four-state model: none of them may read as a bare tick.
  const known = ['Not installed', 'Not signed in', 'Ready', 'Sign-in unknown'];
  check(
    badges.every((b) => known.includes(b.trim())),
    'and every badge is one of the four documented states',
  );
  // `unknown` must not be coloured as success — that is the whole reason it is
  // a separate state rather than being rounded to Ready.
  const okBadges = await section.locator('.settings-badge.badge-ok').allInnerTexts();
  check(
    okBadges.every((b) => b.trim() === 'Ready'),
    'only "Ready" uses the success colour',
    okBadges.join(', ') || 'none',
  );
  await page.screenshot({ path: path.join(SHOTS, 'agent-setup-section.png'), fullPage: false });

  heading('Open the setup dialog');
  await section.locator('button', { hasText: 'Set up agents…' }).click();
  await page.waitForSelector('.agent-setup-dialog', { timeout: 10_000 });
  const dialog = page.locator('.agent-setup-dialog');
  check(await dialog.isVisible(), 'the dialog opens');
  check(
    (await dialog.locator('h2').innerText()).includes('Agent setup'),
    'titled so it is obvious what it is for',
  );

  heading('Every installable row discloses what would be fetched');
  const metas = await dialog.locator('.planner-row-meta').allInnerTexts();
  const pinned = metas.filter((m) => /@\d+\.\d+\.\d+/.test(m));
  check(pinned.length > 0, 'a pinned package@version is shown before anything runs', pinned[0] ?? '');
  check(
    pinned.every((m) => !m.includes('latest')),
    'and nothing floats on "latest"',
  );
  // `agy` has no npm package, so its row must explain that rather than offer a
  // button that cannot work.
  const agyRow = dialog.locator('.planner-model-row').filter({ hasText: 'Antigravity' });
  if ((await agyRow.count()) > 0) {
    const agyText = await agyRow.innerText();
    check(
      !/\bInstall\b/.test(await agyRow.locator('.planner-row-actions').innerText().catch(() => '')),
      'agy offers no Install action',
    );
    check(/npm package/i.test(agyText), 'and says why', agyText.split('\n').pop()?.slice(0, 60));
  }
  await page.screenshot({ path: path.join(SHOTS, 'agent-setup-dialog.png') });

  heading('A signed-out agent points at a Shell session rather than a dead end');
  const hints = (await dialog.locator('.planner-row-meta').allInnerTexts()).join('\n');
  if (/not signed in/i.test(hints)) {
    check(/Shell session/i.test(hints), 'the sign-in pointer names a Shell session on this host');
  } else {
    console.log('  ·  no signed-out agent on this host — pointer not exercised');
  }

  heading('An install streams output instead of a silent spinner');
  const installButtons = dialog.locator('.planner-row-actions button');
  const count = await installButtons.count();
  if (count === 0) {
    console.log('  ·  nothing installable here (prefix not detectable?) — install not exercised');
  } else {
    await installButtons.first().click();
    // The log box must appear promptly; that is the acceptance criterion this
    // whole SSE path exists for.
    check(
      await until(async () => (await dialog.locator('.agent-install-log').count()) === 1, 20_000),
      'the log box appears',
    );
    check(
      await until(async () => {
        const text = await dialog.locator('.agent-install-log').innerText();
        return text.trim().length > 0 && text.trim() !== 'Starting…';
      }, 120_000),
      'and real output arrives in it',
    );
    await page.screenshot({ path: path.join(SHOTS, 'agent-install-progress.png') });

    heading('The install reaches a definite end, and says which');
    check(
      await until(async () => {
        const h3 = await dialog.locator('.planner-section h3').innerText().catch(() => '');
        return /Install finished|Install failed/.test(h3);
      }, 300_000),
      'it finishes rather than spinning forever',
    );
    const outcome = await dialog.locator('.planner-section h3').innerText();
    console.log(`  ·  outcome: ${outcome}`);
    if (/failed/i.test(outcome)) {
      // The other acceptance criterion: a failure shows the real reason.
      const shown = await dialog.locator('.error-box').innerText().catch(() => '');
      check(shown.trim().length > 0, 'a failure shows a real message, not a bare "failed"', shown.slice(0, 80));
    }
    await page.screenshot({ path: path.join(SHOTS, 'agent-install-finished.png') });
  }

  heading('Closing and reopening does not restart anything');
  await dialog.locator('.dialog-actions button').click();
  check(
    await until(async () => (await page.locator('.agent-setup-dialog').count()) === 0),
    'the dialog closes',
  );
  await section.locator('button', { hasText: 'Set up agents…' }).click();
  await page.waitForSelector('.agent-setup-dialog', { timeout: 10_000 });
  check(
    (await page.locator('.agent-setup-dialog .agent-install-log').count()) === 0,
    'reopening shows the list, not a stale log',
  );

  heading('The composer offers setup instead of a dead disabled row');
  await page.locator('.agent-setup-dialog .dialog-actions button').click();
  await page.goto(`${BASE}/#/new`, { waitUntil: 'domcontentloaded' });
  const agentRow = page.locator('.selector-row').filter({ hasText: 'Agent' });
  if ((await agentRow.count()) > 0) {
    await agentRow.first().click();
    const sheet = page.locator('.sheet');
    check(await sheet.isVisible(), 'the agent sheet opens');
    const options = await sheet.locator('.sheet-option').allInnerTexts();
    const missing = options.filter((o) => /not installed/i.test(o));
    if (missing.length > 0) {
      check(
        missing.every((o) => /tap to set up/i.test(o)),
        'a missing agent invites setup rather than reading as a dead end',
        missing[0]?.replace(/\n/g, ' · ').slice(0, 70),
      );
      check(
        (await sheet.locator('.sheet-option[disabled]').count()) === 0 ||
          (await sheet.locator('.sheet-option:disabled').count()) === 0,
        'and is not disabled',
      );
    } else {
      console.log('  ·  every agent installed on this host — composer prompt not exercised');
    }
    await page.screenshot({ path: path.join(SHOTS, 'agent-setup-composer.png') });
  }
} catch (err) {
  failures++;
  console.error('\nFATAL:', err);
  await page.screenshot({ path: path.join(SHOTS, 'agent-install-failure.png') }).catch(() => {});
} finally {
  await browser.close();
  console.log(
    failures === 0
      ? `\n✅ all ${step} steps passed`
      : `\n❌ ${failures} check(s) failed across ${step} steps`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

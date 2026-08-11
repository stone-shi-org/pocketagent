#!/usr/bin/env node
/**
 * Browser pass over the resume picker and the attach picker, at phone size.
 *
 * The protocol demo proves the server does the right thing; this proves the
 * user is told what is about to happen before it does — the confirm step, the
 * live-session warning, and the "we are not resizing your terminal" banner.
 *
 * Expects the scratch verification server (see resume-adopt-demo.mjs).
 */
import { chromium, devices } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.PA_BASE ?? 'http://127.0.0.1:8788';
const PROJECT = process.env.PA_PROJECT ?? '/tmp/pa-verify/project';
const USER_SOCKET = process.env.PA_USER_SOCKET ?? 'pa-verify-user';
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
const tmux = (...args) =>
  execFileSync('tmux', ['-L', USER_SOCKET, ...args], { encoding: 'utf8' }).trim();

async function launch() {
  for (const options of [
    {},
    { channel: 'chrome' },
    { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] },
  ]) {
    try {
      return await chromium.launch(options);
    } catch {
      /* try the next one */
    }
  }
  throw new Error('no usable Chromium');
}

// A pane for the Attach tab to find, as if the user had opened it themselves.
try {
  tmux('kill-server');
} catch {
  /* none */
}
execFileSync('tmux', [
  '-L', USER_SOCKET, '-f', '/dev/null',
  'new-session', '-d', '-s', 'mywork', '-c', PROJECT, '-x', '110', '-y', '32',
  '--', '/bin/bash', '--norc', '--noprofile', '-i',
]);
await new Promise((r) => setTimeout(r, 800));

const browser = await launch();
const context = await browser.newContext({ ...devices['iPhone 13'] });
const page = await context.newPage();

try {
  heading('Log in');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="password"]', TOKEN);
  await page.click('button[type="submit"]');
  await page.waitForSelector('button:has-text("New session")', { timeout: 15_000 });
  check(true, 'signed in on a phone-sized viewport');

  heading('Open the new-session dialog');
  await page.click('button:has-text("New session")');
  await page.waitForSelector('[role="dialog"]');
  // The Attach tab only appears once /api/adoptable has answered.
  await page.waitForSelector('[role="tab"]:has-text("Attach")', { timeout: 10_000 });
  const tabs = await page.locator('[role="tab"]').allTextContents();
  check(tabs.some((t) => t.startsWith('New')), 'New tab present');
  check(tabs.some((t) => t.startsWith('Resume')), 'Resume tab present', tabs.join(' | '));
  check(tabs.some((t) => t.startsWith('Attach')), 'Attach tab present — adoption is enabled');

  heading('The Resume tab lists a real conversation');
  await page.click('[role="tab"]:has-text("Resume")');
  await page.waitForSelector('.pick-row');
  const rowText = await page.locator('.pick-row').first().innerText();
  check(rowText.length > 0, 'a conversation is listed', rowText.split('\n')[0]);
  check(
    (await page.locator('.transport-hint').innerText()).includes('branches by default'),
    'the branching promise is stated up front',
  );
  await page.screenshot({ path: path.join(SHOTS, 'resume-list.png') });

  heading('Expanding a conversation offers branch first, in-place second');
  await page.locator('.pick-row .pick-main').first().click();
  await page.waitForSelector('.pick-actions');
  const actions = await page.locator('.pick-actions button').allTextContents();
  check(actions[0] === 'Resume as new branch', 'the safe action is primary and first', actions[0]);
  check(actions[1] === 'Continue in place…', 'the risky one is secondary and ends in an ellipsis');
  check(
    (await page.locator('.pick-actions button.primary').count()) === 1,
    'only the safe action is styled primary',
  );

  heading('"Continue in place" demands a confirmation');
  await page.click('.pick-actions button:has-text("Continue in place")');
  await page.waitForSelector('h2:has-text("Continue in place?")');
  const confirmText = await page.locator('[role="dialog"]').innerText();
  check(confirmText.includes('instead of branching'), 'it says what it will do differently');
  check(
    confirmText.includes('Resume as new branch'),
    'and points back at the safe option',
  );
  await page.screenshot({ path: path.join(SHOTS, 'resume-confirm.png') });

  heading('Backing out of the confirmation changes nothing');
  await page.click('button:has-text("Back")');
  await page.waitForSelector('.pick-list');
  check(await page.locator('[role="dialog"]').isVisible(), 'back returns to the list');

  heading('The Attach tab lists the pane the user opened');
  await page.click('[role="tab"]:has-text("Attach")');
  await page.waitForSelector('.pick-list .pick-row');
  const paneText = await page.locator('.pick-list .pick-row').first().innerText();
  check(paneText.includes('mywork'), 'the pane is offered', paneText.replace(/\n/g, ' · '));
  check(paneText.includes('110×32'), 'with its real size shown');
  await page.screenshot({ path: path.join(SHOTS, 'adopt-list.png') });

  heading('Attaching demands a confirmation naming the real hazards');
  await page.locator('.pick-list .pick-row').first().click();
  await page.waitForSelector('h2:has-text("Attach to this pane?")');
  const adoptConfirm = await page.locator('[role="dialog"]').innerText();
  check(/resize/i.test(adoptConfirm), 'warns that the terminal may resize');
  check(/prefix/i.test(adoptConfirm), 'warns that their tmux prefix is live');
  check(/detach/i.test(adoptConfirm), 'says that closing only detaches');
  await page.screenshot({ path: path.join(SHOTS, 'adopt-confirm.png') });

  heading('Confirming lands on the mirrored terminal');
  await page.click('[role="dialog"] button.primary');
  await page.waitForSelector('.terminal-page', { timeout: 20_000 });
  const notice = await page.locator('.notice').first().innerText();
  check(/Attached to your own tmux pane/.test(notice), 'the banner explains the shared grid', notice.split('.')[0]);
  check(/110×32/.test(notice), "and reports the pane's size");
  check(
    await page.locator('button:has-text("Fit to this screen anyway")').isVisible(),
    'resizing is offered as a deliberate choice, not a side effect',
  );

  heading('Typing from the phone reaches the shell');
  const sendButton = page.locator('.promptbar button:has-text("Send")');
  await page.locator('.promptbar textarea').fill('echo HELLO_FROM_UI');
  try {
    await sendButton.waitFor({ state: 'attached', timeout: 5000 });
    await page.waitForFunction(
      () => {
        const b = [...document.querySelectorAll('.promptbar button')].find((x) =>
          x.textContent?.includes('Send'),
        );
        return b && !b.disabled;
      },
      undefined,
      { timeout: 15_000 },
    );
  } catch {
    const badge = await page.locator('.badge, .conn-badge').allTextContents();
    console.log('     (diagnostics) badges:', JSON.stringify(badge));
    console.log('     (diagnostics) notices:', JSON.stringify(await page.locator('.notice').allTextContents()));
  }
  await sendButton.click();
  await page.waitForFunction(
    () => document.querySelector('.xterm-screen')?.textContent?.includes('HELLO_FROM_UI'),
    undefined,
    { timeout: 20_000 },
  );
  check(true, 'the output appears in the mirrored terminal');
  await page.screenshot({ path: path.join(SHOTS, 'adopt-terminal.png') });

  heading('Stopping the session leaves the pane alive');
  page.once('dialog', (d) => void d.accept());
  await page.click('button:has-text("Stop")');
  await new Promise((r) => setTimeout(r, 2000));
  let alive = true;
  try {
    tmux('has-session', '-t', '=mywork');
  } catch {
    alive = false;
  }
  check(alive, "the user's tmux session is still there");
  check(Number(tmux('list-sessions', '-F', '#{session_attached}')) === 0, 'and we detached');
} catch (err) {
  failures++;
  console.error('\nFATAL:', err);
  await page.screenshot({ path: path.join(SHOTS, 'ui-failure.png') }).catch(() => {});
} finally {
  await browser.close();
  try {
    tmux('kill-server');
  } catch {
    /* gone */
  }
  console.log(
    failures === 0
      ? `\n✅ all ${step} steps passed — screenshots in screenshots/`
      : `\n❌ ${failures} check(s) failed across ${step} steps`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

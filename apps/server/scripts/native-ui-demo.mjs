#!/usr/bin/env node
/**
 * Drives the native (structured) UI in a real browser at phone size.
 *
 * Point PA_BASE at a server whose workspace root is a scratch directory —
 * this asks the agent to edit files.
 */
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.PA_BASE ?? 'http://127.0.0.1:8787';
const REPO = new URL('../../../', import.meta.url).pathname;
const SHOTS = path.join(REPO, 'screenshots');
const TOKEN = fs
  .readFileSync(path.join(REPO, '.env'), 'utf8')
  .match(/^POCKETAGENT_AUTH_TOKEN=(.+)$/m)[1]
  .trim();

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

async function launch() {
  for (const options of [
    {},
    { channel: 'chrome' },
    { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] },
  ]) {
    try {
      return await chromium.launch(options);
    } catch {
      /* try next */
    }
  }
  throw new Error('no usable browser');
}

const browser = await launch();
const context = await browser.newContext({ ...devices['iPhone 13'] });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(String(e)));

const shot = async (name) => {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  return `screenshots/${name}.png`;
};

console.log('PocketAgent native UI demo (iPhone 13 viewport)\n' + '='.repeat(60));

heading('Log in');
{
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('#token', TOKEN);
  await page.click('button[type=submit]');
  await page.waitForSelector('text=+ New session', { timeout: 15_000 });
  check(true, 'reached the session list');
}

heading('The new-session dialog offers a transport choice');
{
  await page.click('text=+ New session');
  await page.waitForSelector('#agent');
  await page.selectOption('#agent', 'claude');
  await page.waitForSelector('#transport', { timeout: 5000 });

  const options = await page.locator('#transport option').allTextContents();
  check(options.some((o) => /Native/.test(o)), 'native option offered', options.join(' / '));
  check(
    (await page.locator('#transport').inputValue()) === 'structured',
    'structured is preselected for Claude',
  );
  console.log(`     saved ${await shot('20-transport-picker')}`);

  const wsValues = await page.locator('#cwd option').evaluateAll((os) => os.map((o) => o.value));
  await page.selectOption('#cwd', wsValues.length > 1 ? wsValues[1] : wsValues[0]);
  await page.click('.dialog-actions button.primary');
}

heading('The native transcript renders, not a terminal');
{
  await page.waitForSelector('.transcript', { timeout: 20_000 });
  check((await page.locator('.xterm').count()) === 0, 'no terminal emulator mounted');
  check((await page.locator('.promptbar textarea').count()) === 1, 'prompt box present');
  console.log(`     saved ${await shot('21-native-empty')}`);
}

heading('Ask a question; answer renders as markdown with a tool card');
{
  await page.fill('.promptbar textarea', 'Read secret.txt and tell me the passphrase in bold.');
  await page.click('.promptbar button');

  // Approve anything the agent asks for while it works.
  const approve = setInterval(() => {
    page
      .locator('.approval-sheet button.primary')
      .click({ timeout: 500 })
      .catch(() => undefined);
  }, 700);

  await page.waitForSelector('.tool-card', { timeout: 90_000 });
  check(true, 'a tool card appeared');

  // Wait for the turn to actually finish; asserting mid-stream races the
  // streaming preview against the completed block.
  await page
    .waitForFunction(() => document.querySelectorAll('.turn-footer').length >= 1, {
      timeout: 120_000,
    })
    .catch(() => undefined);
  clearInterval(approve);

  const answers = await page.locator('.answer').evaluateAll((els) => els.map((e) => e.innerHTML));
  check(answers.some((a) => /<strong>/.test(a)), 'markdown bold rendered as real HTML');
  check(answers.some((a) => /heron/i.test(a)), 'the answer contains the passphrase');
  check(
    (await page.locator('.answer.streaming').count()) === 0,
    'no leftover streaming placeholder',
  );

  const summary = await page.locator('.tool-card .tool-summary').first().textContent();
  check(/Read/.test(summary ?? ''), 'tool card shows a readable summary', summary?.trim());
  console.log(`     saved ${await shot('22-native-answer')}`);
}

heading('Cost chip and file list appear');
{
  const chips = await page.locator('.agent-strip .chip').allTextContents();
  check(chips.some((c) => c.includes('$')), 'cost chip shown', chips.join(' | '));
  check(chips.some((c) => /file/.test(c)), 'touched-files chip shown');

  await page.locator('.agent-strip .chip', { hasText: 'file' }).click();
  await page.waitForSelector('.file-list li');
  const files = await page.locator('.file-list li').allTextContents();
  check(files.length > 0, 'file list expands', files.join(', '));
  console.log(`     saved ${await shot('23-native-files')}`);
  await page.locator('.agent-strip .chip', { hasText: 'file' }).click();
}

heading('Tool cards expand to show details');
{
  await page.locator('.tool-card .tool-head').first().click();
  await page.waitForSelector('.tool-card .tool-body');
  check(true, 'tool card expanded');
  await page.locator('.tool-card .tool-head').first().click();
}

heading('An edit raises a native approval sheet with a diff');
{
  await page.fill(
    '.promptbar textarea',
    'Create a file notes.md containing a markdown list of three fruits.',
  );
  await page.click('.promptbar button');

  await page.waitForSelector('.approval-sheet', { timeout: 90_000 });
  check(true, 'approval sheet appeared');

  const title = await page.locator('.approval-title').textContent();
  check((title ?? '').length > 0, 'sheet shows the agent’s own wording', title?.trim());

  const hasAllow = await page.locator('.approval-actions button.primary').isVisible();
  const hasDeny = await page.locator('.approval-actions button.danger').isVisible();
  check(hasAllow && hasDeny, 'allow and deny are buttons, not keystrokes');
  console.log(`     saved ${await shot('24-approval-sheet')}`);

  const diffLines = await page.locator('.approval-sheet .diff-line').count();
  check(diffLines > 0, 'the sheet previews the change as a diff', `${diffLines} lines`);
}

heading('Deny with a reason, then allow the retry');
{
  await page.locator('.approval-actions button.danger').click();
  await page.waitForSelector('.approval-sheet textarea');
  await page.fill('.approval-sheet textarea', 'use a numbered list instead');
  console.log(`     saved ${await shot('25-approval-deny')}`);
  await page.locator('.approval-actions button.primary-danger').click();

  // The agent should react to the denial and try again.
  const retried = await page
    .waitForSelector('.approval-sheet', { timeout: 90_000 })
    .then(() => true)
    .catch(() => false);
  check(retried, 'agent retried after the denial');

  if (retried) {
    await page.locator('.approval-actions button.primary').click();
  }
  await page
    .waitForFunction(() => document.querySelectorAll('.turn-footer').length >= 2, { timeout: 90_000 })
    .catch(() => undefined);
  check((await page.locator('.turn-footer').count()) >= 2, 'a second turn completed');
  console.log(`     saved ${await shot('26-native-after-approval')}`);
}

heading('Reload resumes the transcript');
{
  const before = await page.locator('.answer, .bubble.user, .tool-card').count();
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.transcript', { timeout: 20_000 });
  await page.waitForFunction(
    (n) => document.querySelectorAll('.answer, .bubble.user, .tool-card').length >= n,
    Math.min(before, 3),
    { timeout: 20_000 },
  );
  const after = await page.locator('.answer, .bubble.user, .tool-card').count();
  check(after >= Math.min(before, 3), 'transcript replayed after reload', `${before} → ${after}`);
  console.log(`     saved ${await shot('27-native-after-reload')}`);
}

heading('Session list distinguishes native from terminal');
{
  await page.click('button[aria-label="Back to sessions"]');
  await page.waitForSelector('.session-card');
  const details = await page.locator('.session-card .detail').allTextContents();
  check(details.some((d) => d.includes('native')), 'native sessions labelled', details[0]?.trim());
  console.log(`     saved ${await shot('28-native-session-list')}`);
}

heading('No unexpected console errors');
{
  const real = consoleErrors.filter((e) => !/WebSocket|Failed to load resource|net::ERR/i.test(e));
  check(real.length === 0, 'browser console clean', real.slice(0, 2).join(' | '));
}

await browser.close();
console.log('\n' + '='.repeat(60));
console.log(failures === 0 ? '✅ ALL NATIVE UI CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

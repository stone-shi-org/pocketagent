#!/usr/bin/env node
/**
 * Drives the real browser UI at iPhone viewport size against a running server.
 * This exercises what the protocol tests cannot: xterm rendering, the mobile
 * key bar, the prompt box, hash routing, and reload-then-resume.
 *
 * Run with the server up:  node scripts/browser-demo.mjs
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

/**
 * Prefer Playwright's own Chromium; fall back to the system Chrome so this can
 * run without a browser download.
 */
async function launch() {
  const attempts = [
    {},
    { channel: 'chrome' },
    { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] },
  ];
  let lastError;
  for (const options of attempts) {
    try {
      return await chromium.launch(options);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

const browser = await launch();
const context = await browser.newContext({
  ...devices['iPhone 13'],
  // The self-hosted case: plain HTTP over a VPN.
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

/** Read the visible text xterm has actually rendered into the DOM. */
const terminalText = () =>
  page.evaluate(() => {
    const rows = document.querySelectorAll('.xterm-rows > div');
    return [...rows].map((r) => r.textContent).join('\n');
  });

const shot = async (name) => {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  return `screenshots/${name}.png`;
};

let firstSessionId = null;
let workspaceValue = null;

console.log('PocketAgent browser UI demo (iPhone 13 viewport)\n' + '='.repeat(60));

heading('Login screen renders');
{
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#token');
  check(await page.locator('h1', { hasText: 'PocketAgent' }).isVisible(), 'login card visible');
  check(
    (await page.locator('#token').getAttribute('type')) === 'password',
    'token field is password-style',
  );
  const html = await page.content();
  check(!html.includes(TOKEN), 'token is not present anywhere in the served HTML');
  console.log(`     saved ${await shot('01-login')}`);
}

heading('Invalid token shows a clear error');
{
  await page.fill('#token', 'this-token-is-definitely-wrong-xx');
  await page.click('button[type=submit]');
  await page.waitForSelector('.error-box');
  const text = await page.locator('.error-box').textContent();
  check(/invalid/i.test(text), 'error message shown', text.trim());
  console.log(`     saved ${await shot('02-login-error')}`);
}

heading('Log in with the real token');
{
  await page.fill('#token', TOKEN);
  await page.click('button[type=submit]');
  await page.waitForSelector('text=+ New session', { timeout: 10_000 });
  check(true, 'reached the session list');

  const storage = await page.evaluate(() => ({
    local: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
  }));
  check(!storage.local.includes(TOKEN), 'token not in localStorage');
  check(!storage.session.includes(TOKEN), 'token not in sessionStorage');

  const cookies = await context.cookies();
  const auth = cookies.find((c) => c.name === 'pocketagent_sid');
  check(auth?.httpOnly === true, 'auth cookie is HttpOnly');
  check(auth?.sameSite === 'Strict', 'auth cookie is SameSite=Strict');
  console.log(`     saved ${await shot('03-session-list-empty')}`);
}

heading('Start a shell session from the New Session dialog');
{
  await page.click('text=+ New session');
  await page.waitForSelector('#agent');

  const agentOptions = await page.locator('#agent option').allTextContents();
  check(agentOptions.some((o) => /Claude/.test(o)), 'Claude offered', agentOptions.join(' / '));
  check(agentOptions.some((o) => /Shell/.test(o)), 'Shell offered');

  const wsOptions = await page.locator('#cwd option').allTextContents();
  check(wsOptions.length > 0, 'workspace offered', wsOptions.join(' / '));
  // Prefer a child directory, else the root; never assume a fixture path.
  const wsValues = await page.locator('#cwd option').evaluateAll((os) => os.map((o) => o.value));
  workspaceValue = wsValues.length > 1 ? wsValues[1] : wsValues[0];
  console.log(`     saved ${await shot('04-new-session-dialog')}`);

  await page.selectOption('#agent', 'shell');
  await page.selectOption('#cwd', workspaceValue);
  await page.click('.dialog-actions button.primary');

  await page.waitForSelector('.terminal-host .xterm', { timeout: 15_000 });
  check(/#\/s\//.test(page.url()), 'navigated to the terminal route', page.url().split('#')[1]);
  firstSessionId = page.url().split('/s/')[1];
}

heading('Terminal shows a live shell prompt');
{
  // The prompt shows the working directory, whatever it is configured to be.
  const leaf = workspaceValue.split('/').pop();
  await page.waitForFunction(
    (needle) => document.querySelector('.xterm-rows')?.textContent?.includes(needle),
    leaf,
    { timeout: 15_000 },
  );
  const text = await terminalText();
  check(text.includes(leaf), 'prompt rendered by xterm.js', leaf);
  check(
    (await page.locator('.badge.connected').count()) > 0,
    'connection badge reads Connected',
  );
  console.log(`     saved ${await shot('05-terminal-prompt')}`);
}

heading('Type into xterm directly and see the result');
{
  await page.click('.terminal-host');
  await page.keyboard.type('echo hello-from-xterm');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => (document.querySelector('.xterm-rows')?.textContent?.match(/hello-from-xterm/g) ?? []).length >= 2,
    { timeout: 10_000 },
  );
  check(true, 'keystrokes reached the PTY and output came back');
}

heading('Send a prompt via the mobile prompt box');
{
  await page.fill('.promptbar textarea', 'echo sent-from-prompt-box');
  await page.click('.promptbar button');
  await page.waitForFunction(
    () => document.querySelector('.xterm-rows')?.textContent?.includes('sent-from-prompt-box'),
    { timeout: 10_000 },
  );
  check(true, 'prompt box sent text followed by Enter');
  check((await page.inputValue('.promptbar textarea')) === '', 'textarea cleared after send');
  console.log(`     saved ${await shot('06-terminal-after-commands')}`);
}

heading('Mobile key bar sends real control sequences');
{
  // Start a long-running command, then interrupt it with the ^C button.
  await page.click('.terminal-host');
  await page.keyboard.type('sleep 45');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);

  await page.locator('.keybar button[aria-label="Control C"]').click();
  await page.waitForTimeout(600);

  await page.click('.terminal-host');
  await page.keyboard.type('echo interrupted-ok');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.querySelector('.xterm-rows')?.textContent?.includes('interrupted-ok'),
    { timeout: 10_000 },
  );
  check(true, '^C interrupted the foreground job, shell survived');

  // Arrow-up should recall history.
  await page.locator('.keybar button[aria-label="Up arrow"]').click();
  await page.waitForTimeout(400);
  const text = await terminalText();
  check(/echo interrupted-ok/.test(text), 'Up arrow recalled the previous command');
  await page.locator('.keybar button[aria-label="Control C"]').click();
}

heading('Reload the page and resume the same session');
{
  const url = page.url();
  const before = await terminalText();
  check(before.includes('hello-from-xterm'), 'history present before reload');

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.terminal-host .xterm', { timeout: 15_000 });
  check(page.url() === url, 'hash route survived the reload');

  await page.waitForFunction(
    () => document.querySelector('.xterm-rows')?.textContent?.includes('hello-from-xterm'),
    { timeout: 15_000 },
  );
  check(true, 'buffered history replayed into a fresh terminal');

  // And it is still interactive.
  await page.click('.terminal-host');
  await page.keyboard.type('echo after-reload');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.querySelector('.xterm-rows')?.textContent?.includes('after-reload'),
    { timeout: 10_000 },
  );
  check(true, 'session still interactive after reload');
  console.log(`     saved ${await shot('07-after-reload')}`);
}

heading('Rotate to landscape and confirm the PTY resizes');
{
  const before = await page.evaluate(() =>
    fetch('/api/sessions', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((j) => j.sessions.find((s) => s.status === 'running')),
  );

  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(1200); // debounce + round trip

  const after = await page.evaluate(() =>
    fetch('/api/sessions', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((j) => j.sessions.find((s) => s.status === 'running')),
  );

  check(
    after.cols !== before.cols,
    'PTY columns changed on rotation',
    `${before.cols}x${before.rows} -> ${after.cols}x${after.rows}`,
  );

  await page.click('.terminal-host');
  await page.keyboard.type('echo COLS=$(tput cols)');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (expected) => document.querySelector('.xterm-rows')?.textContent?.includes(`COLS=${expected}`),
    after.cols,
    { timeout: 10_000 },
  );
  check(true, 'child process agrees with the new width', `COLS=${after.cols}`);
  console.log(`     saved ${await shot('08-landscape')}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
}

heading('Switch between multiple sessions without killing the first');
{
  await page.click('button[aria-label="Back to sessions"]');
  await page.waitForSelector('text=+ New session');

  await page.click('text=+ New session');
  await page.waitForSelector('#agent');
  await page.selectOption('#agent', 'shell');
  // Any workspace will do for the second session; reuse the same one.
  await page.selectOption('#cwd', workspaceValue);
  await page.click('.dialog-actions button.primary');
  await page.waitForSelector('.terminal-host .xterm', { timeout: 15_000 });

  await page.click('button[aria-label="Back to sessions"]');
  await page.waitForSelector('.session-card');
  const running = await page.locator('.badge.running').count();
  check(running >= 2, 'two sessions running side by side', `${running} running`);
  console.log(`     saved ${await shot('09-session-list-two')}`);

  // Reopen the first one by id. (Selecting by position would pick up killed
  // sessions left over from earlier runs.)
  await page.locator(`.session-card[data-session-id="${firstSessionId}"] .meta`).click();
  await page.waitForSelector('.terminal-host .xterm');
  check(page.url().endsWith(firstSessionId), 'returned to the original session');

  // Assert it is still *live*, not that a specific old line is still on screen:
  // by now several commands and a rotation have pushed early output into
  // scrollback, which the rendered rows deliberately do not include.
  await page.click('.terminal-host');
  await page.keyboard.type('echo back-on-session-one');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.querySelector('.xterm-rows')?.textContent?.includes('back-on-session-one'),
    { timeout: 15_000 },
  );
  check(true, 'original session survived the switch and is still interactive');
}

heading('Start a Claude Code session from the UI');
{
  await page.click('button[aria-label="Back to sessions"]');
  await page.waitForSelector('text=+ New session');
  await page.click('text=+ New session');
  await page.waitForSelector('#agent');
  await page.selectOption('#agent', 'claude');
  await page.selectOption('#cwd', workspaceValue);
  await page.click('.dialog-actions button.primary');

  await page.waitForSelector('.terminal-host .xterm', { timeout: 20_000 });
  await page.waitForFunction(
    () => (document.querySelector('.xterm-rows')?.textContent?.length ?? 0) > 150,
    { timeout: 40_000 },
  );

  const text = await terminalText();
  check(/claude|trust this folder|anthropic/i.test(text), 'Claude Code TUI rendered in xterm');
  console.log(`     saved ${await shot('10-claude-session')}`);
  console.log('     ---- what the phone shows ----');
  console.log(
    text
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 14)
      .map((l) => '     | ' + l.trim().slice(0, 90))
      .join('\n'),
  );
}

heading('Answer the interactive prompt with normal keyboard input');
{
  // Claude asks whether the folder is trusted. Answer it exactly as a human at
  // the terminal would — no special-casing anywhere in PocketAgent.
  const before = await terminalText();
  if (/trust this folder/i.test(before)) {
    await page.locator('.keybar button[aria-label="Enter"]').click();
    await page.waitForTimeout(3000);
    const after = await terminalText();
    check(after !== before, 'UI reacted to the approval keystroke');
    console.log(`     saved ${await shot('11-claude-after-approval')}`);
  } else {
    console.log('  ℹ️  no trust prompt shown (already trusted); skipping');
  }
}

heading('Terminate a session from the UI');
{
  page.on('dialog', (d) => d.accept());
  await page.click('button[aria-label="Back to sessions"]');
  await page.waitForSelector('.session-card');

  const runningBefore = await page.locator('.badge.running').count();
  await page.locator('button:has-text("Stop")').first().click();
  await page.waitForTimeout(7000); // SIGTERM grace + SIGKILL
  await page.click('text=Refresh');
  await page.waitForTimeout(1000);

  const runningAfter = await page.locator('.badge.running').count();
  check(runningAfter < runningBefore, 'session count dropped', `${runningBefore} -> ${runningAfter}`);
  check((await page.locator('.badge.killed').count()) > 0, 'a session shows as Killed');
  console.log(`     saved ${await shot('12-after-terminate')}`);
}

heading('No unexpected console errors');
{
  // A WebSocket close during teardown/reload is normal and not a defect.
  const real = consoleErrors.filter(
    (e) => !/WebSocket|Failed to load resource|net::ERR/i.test(e),
  );
  check(real.length === 0, 'browser console clean', real.slice(0, 3).join(' | '));
}

await browser.close();

console.log('\n' + '='.repeat(60));
console.log(failures === 0 ? '✅ ALL BROWSER CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`);
console.log(`Screenshots in ${SHOTS}`);
process.exit(failures === 0 ? 0 : 1);

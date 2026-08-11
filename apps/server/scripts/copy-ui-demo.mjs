#!/usr/bin/env node
/**
 * The copy buttons, in a real browser, over plain HTTP.
 *
 * The origin matters more than it looks. `navigator.clipboard` only exists in a
 * secure context, and this app is normally reached over http:// on a LAN or
 * tailnet address — so the run below is the case that would silently break if
 * the button were built on that API alone. The page is loaded by IP rather than
 * localhost precisely to keep it out of a secure context.
 *
 * What is checked is the clipboard's *contents*: that the markdown source came
 * across, not the rendered prose.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOST = process.env.PA_HOST ?? nonLoopbackAddress();
const PORT = process.env.PA_PORT ?? '8792';
const BASE = `http://${HOST}:${PORT}`;
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

function nonLoopbackAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

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
// No clipboard permission granted on purpose: this is the unprivileged,
// non-secure case a phone on the LAN actually gets.
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

try {
  heading('Load over plain HTTP, off localhost');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const secure = await page.evaluate(() => window.isSecureContext);
  const hasApi = await page.evaluate(() => Boolean(navigator.clipboard));
  check(!secure, 'not a secure context, as on a LAN address', BASE);
  check(!hasApi, 'so navigator.clipboard is unavailable — the fallback is load-bearing');

  await page.fill('input[type="password"]', TOKEN);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.desktop-shell, .projects-page', { timeout: 15_000 });

  heading('Open the conversation and resume it');
  await page.waitForSelector('.chat-row', { timeout: 15_000 });
  await page.locator('.chat-row').first().click();
  await page.waitForSelector('.terminal-page', { timeout: 40_000 });
  check(await until(async () => (await page.locator('.history-divider').count()) === 1, 30_000),
    'history rendered');

  heading('Every prompt and answer offers a copy button');
  const copies = await page.locator('.copy-btn').count();
  check(copies >= 2, 'copy buttons present', `${copies}`);
  check(
    (await page.locator('.message.user .copy-btn').count()) >= 1,
    'one under the prompt bubble',
  );
  check(
    (await page.locator('.message.assistant .copy-btn').count()) >= 1,
    'one under the answer',
  );
  await page.screenshot({ path: path.join(SHOTS, 'copy-buttons.png') });

  heading('Copying the answer puts its markdown source on the clipboard');
  const answerText = await page.locator('.message.assistant').last().locator('.answer').innerText();
  await page.locator('.message.assistant').last().locator('.copy-btn').click();

  const confirmed = await until(
    async () => (await page.locator('.copy-btn.copied').count()) >= 1,
  );
  check(confirmed, 'the button confirms it copied');

  // Read it back through a paste into a real field — the only honest check.
  await page.locator('.promptbar textarea').click();
  await page.keyboard.press('Control+V');
  const pasted = await page.locator('.promptbar textarea').inputValue();
  check(pasted.length > 0, 'something was actually pasted', `${pasted.length} chars`);
  check(
    pasted.includes('42'),
    'and it is the message content',
    pasted.slice(0, 48).replace(/\n/g, '\\n'),
  );
  check(
    pasted.includes('```') || pasted.includes('- '),
    'markdown source, not the rendered prose',
  );
  check(
    answerText.length > 0 && pasted !== answerText,
    'which differs from what is on screen',
  );

  heading('The confirmation goes away on its own');
  check(
    await until(async () => (await page.locator('.copy-btn.copied').count()) === 0, 5000),
    'back to idle',
  );

  heading('Copying a prompt copies the prompt');
  await page.locator('.promptbar textarea').fill('');
  const promptText = (await page.locator('.message.user .bubble').first().innerText()).trim();
  await page.locator('.message.user').first().locator('.copy-btn').click();
  await until(async () => (await page.locator('.copy-btn.copied').count()) >= 1);
  await page.locator('.promptbar textarea').click();
  await page.keyboard.press('Control+V');
  check(
    (await page.locator('.promptbar textarea').inputValue()).trim() === promptText,
    'exactly the prompt text',
    promptText.slice(0, 48),
  );
  await page.locator('.promptbar textarea').fill('');
} catch (err) {
  failures++;
  console.error('\nFATAL:', err);
  await page.screenshot({ path: path.join(SHOTS, 'copy-failure.png') }).catch(() => {});
} finally {
  await browser.close();
  console.log(
    failures === 0
      ? `\n✅ all ${step} steps passed`
      : `\n❌ ${failures} check(s) failed across ${step} steps`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

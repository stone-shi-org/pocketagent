#!/usr/bin/env node
/**
 * The "continue what I was doing" path, end to end in a real browser.
 *
 * Taps a finished chat on the home screen and checks the three things that
 * were broken or missing: it resumes rather than trying to attach to a dead
 * process, it opens showing the earlier messages instead of a blank page, and
 * the next prompt actually continues that conversation.
 *
 * Expects a scratch server whose workspace contains a real Claude transcript.
 */
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.PA_BASE ?? 'http://127.0.0.1:8790';
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

async function until(predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      if (await predicate()) return true;
    } catch {
      /* not there yet */
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
const context = await browser.newContext({ ...devices['iPhone 13'] });
const page = await context.newPage();

try {
  heading('Log in and find the finished chat');
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="password"]', TOKEN);
  await page.click('button[type="submit"]');
  await page.waitForSelector('.projects-page', { timeout: 15_000 });
  await page.waitForSelector('.chat-row', { timeout: 15_000 });

  const rows = await page.locator('.chat-title').allTextContents();
  check(rows.length >= 1, 'a chat is listed', rows[0]);
  check(
    (await page.locator('.chat-row .live-dot').count()) === 0,
    'and it is not running — nothing to attach to',
  );

  heading('Tapping it resumes rather than opening a dead session');
  await page.locator('.chat-row').first().click();
  await page.waitForSelector('.terminal-page', { timeout: 40_000 });
  const fatal = await page.locator('.notice').allTextContents();
  check(
    !fatal.some((t) => /no longer available|no longer exists/i.test(t)),
    'no "session no longer available"',
    fatal.join(' | ') || 'no notices',
  );

  heading('It opens showing what was said before');
  const gotHistory = await until(
    async () => (await page.locator('.history-divider').count()) === 1,
    30_000,
  );
  check(gotHistory, 'the resumed conversation is rendered above a "Resumed here" marker');

  const body = await page.locator('.transcript').innerText();
  check(/fact\.txt/i.test(body), 'the original prompt is there', firstLine(body));
  check(/\b42\b/.test(body), "and the agent's earlier answer");
  check(
    !/Send a prompt to start the conversation/.test(body),
    'so it does not look like an empty chat',
  );
  await page.screenshot({ path: path.join(SHOTS, 'resume-history.png') });

  heading('The next prompt continues that conversation');
  await page.locator('.promptbar textarea').fill('What number did you just tell me? Reply with only the number.');
  await until(async () => !(await page.locator('.promptbar button.primary').isDisabled()));
  await page.click('.promptbar button.primary');

  const answered = await until(async () => {
    const text = await page.locator('.transcript').innerText();
    // Two "42"s means the new turn produced one of its own.
    return (text.match(/\b42\b/g) ?? []).length >= 2;
  }, 180_000);
  check(answered, 'it remembered the earlier turn, so the resume was real');
  await page.screenshot({ path: path.join(SHOTS, 'resume-history-answered.png') });

  heading('The original transcript is untouched — the resume branched');
  const projects = path.join(
    process.env.HOME,
    '.claude/projects',
    (process.env.PA_PROJECT ?? '/tmp/pa-hist/project').replace(/\//g, '-'),
  );
  const files = fs.readdirSync(projects).filter((f) => f.endsWith('.jsonl'));
  check(files.length === 2, 'a second transcript was branched off', `${files.length} files`);
} catch (err) {
  failures++;
  console.error('\nFATAL:', err);
  await page.screenshot({ path: path.join(SHOTS, 'resume-history-failure.png') }).catch(() => {});
} finally {
  await browser.close();
  console.log(
    failures === 0
      ? `\n✅ all ${step} steps passed`
      : `\n❌ ${failures} check(s) failed across ${step} steps`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

function firstLine(s) {
  return (s.split('\n').find((l) => l.trim()) ?? '').slice(0, 60);
}

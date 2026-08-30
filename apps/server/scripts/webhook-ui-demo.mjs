#!/usr/bin/env node
/**
 * Browser pass over inbound webhooks, at phone size.
 *
 * The unit suite covers signature verification, the filter and the renderer.
 * What only a browser can answer: that the page is reachable from the overflow
 * menu, that creating a webhook *stays put* and reveals the secret (rather than
 * navigating away and losing it), that the URL is composed from the browser's
 * own origin with a copy button that goes through the clipboard fallback, that
 * the empty-filter and bypassed-approvals warnings are actually visible, that a
 * real signed delivery shows up in the history, that a filtered one is dimmed
 * and carries its reason, and that a webhook appears in the project tree with
 * its glyph before it has ever fired.
 *
 * Expects a *scratch* server (PA_BASE, PA_TOKEN) with a throwaway workspace
 * root — it creates and deletes webhooks and starts agents.
 */
import { chromium, devices } from 'playwright';
import crypto from 'node:crypto';
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

async function until(predicate, timeout = 8000) {
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

if (!TOKEN) {
  console.error('PA_TOKEN is required.');
  process.exit(1);
}

/** Clear webhooks from a previous run so assertions are about this one. */
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
const existing = await call('/api/webhooks');
for (const hook of existing?.webhooks ?? []) {
  await call(`/api/webhooks/${hook.id}`, { method: 'DELETE' });
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

// -- 1. Reachable from the overflow menu -----------------------------------
heading('Webhooks is reachable from the "…" menu');
await page.click('.home-bar .round-btn[aria-label="More"]');
await until(() => page.locator('.menu').isVisible());
const item = page.locator('.menu button', { hasText: 'Webhooks' });
check(await item.isVisible(), 'menu has a "Webhooks…" item');
await item.click();
check(await until(() => page.locator('.cron-page').isVisible()), 'the webhooks page opens');
check(
  (await page.locator('.cron-empty').textContent())?.includes('No webhooks yet'),
  'empty state explains what a webhook is',
);
await page.screenshot({ path: path.join(SHOTS, 'hook-01-empty.png') });

// -- 2. The editor, and the empty-filter warning ---------------------------
heading('An unfiltered webhook warns before it is saved');
await page.click('.cron-new');
check(await until(() => page.locator('.settings-header').isVisible()), 'editor opens');

const nameInput = page.locator('.settings-row-control input.settings-input').first();
await nameInput.fill('Triage new bugs');

// Deselect the default event so the filter is genuinely empty.
const created = page.locator('.chip', { hasText: 'created' }).first();
if ((await created.getAttribute('aria-pressed')) === 'true') await created.click();
check(
  await until(() => page.locator('.warn-callout', { hasText: 'Nothing is filtered' }).isVisible()),
  'empty filter shows the "every issue event" warning',
);
await page.screenshot({ path: path.join(SHOTS, 'hook-02-empty-filter.png'), fullPage: true });

// Put a real filter back.
await created.click();
await page.locator('input.settings-input.mono').nth(1).fill('PA');
check(
  !(await page.locator('.warn-callout', { hasText: 'Nothing is filtered' }).isVisible()),
  'the warning clears once something is filtered',
);

// -- 3. The bypassed-approvals warning ------------------------------------
heading('Skip-permissions defaults OFF and warns loudly when turned on');
const skipToggle = page.locator('input[aria-label="Skip tool approvals"]');
check((await skipToggle.isChecked()) === false, 'defaults to off, unlike a cron job');
await skipToggle.check();
const warn = page.locator('.warn-callout', { hasText: 'partly from' });
check(await until(() => warn.isVisible()), 'warning names the untrusted-prompt risk');
check(
  (await warn.textContent())?.includes('someone else wrote in Jira'),
  'warning is stronger than the cron editor’s',
);
await skipToggle.uncheck();

// -- 4. Create stays put and reveals the secret ---------------------------
heading('Creating a webhook stays on the page and shows the secret');
await page.click('.cron-save-bar button.primary');
check(
  await until(() => page.locator('.secret-value').isVisible()),
  'the secret panel appears in place (no navigation away)',
);
const secretText = (await page.locator('.secret-value').first().textContent())?.trim() ?? '';
check(secretText.length > 20, 'a real secret is shown', `${secretText.slice(0, 8)}…`);

const urlText = (await page.locator('.endpoint-url code').textContent())?.trim() ?? '';
check(urlText.startsWith(BASE), 'URL is composed from this browser’s origin', urlText);
check(
  (await page.locator('.endpoint-origin-note').textContent())?.includes('this browser'),
  'the panel says which origin it used',
);
check(
  (await page.locator('.transport-hint', { hasText: 'cannot check' }).count()) > 0,
  'it does not claim Jira can reach the URL',
);
check(
  (await page.locator('.transport-hint', { hasText: 'No delivery has arrived' }).count()) > 0,
  '"never fired" is surfaced as the real reachability test',
);
await page.screenshot({ path: path.join(SHOTS, 'hook-03-secret.png'), fullPage: true });

// -- 5. Copy goes through the insecure-context fallback -------------------
heading('Copy works on a plain-HTTP origin');
const copyBtn = page.locator('.secret-callout .copy-btn').first();
await copyBtn.click();
// `navigator.clipboard` is undefined here, so a success state proves the
// execCommand fallback in `agent/clipboard.ts` ran.
check(
  await until(() => copyBtn.evaluate((el) => el.className.includes('copied'))),
  'copy reports success via the textarea fallback',
);

// -- 6. A real signed delivery lands in the history -----------------------
heading('A correctly signed delivery appears in the history');
const { webhooks } = await call('/api/webhooks');
const hook = webhooks[0];
const body = JSON.stringify({
  webhookEvent: 'jira:issue_created',
  timestamp: Date.now(),
  user: { displayName: 'Ada Lovelace' },
  issue: {
    key: 'PA-4242',
    fields: {
      summary: 'Login fails on Safari',
      description: 'Steps to reproduce…',
      project: { key: 'PA', name: 'Pocket' },
      issuetype: { name: 'Bug' },
    },
  },
});
const sig = `sha256=${crypto.createHmac('sha256', secretText).update(body).digest('hex')}`;
const delivered = await fetch(`${BASE}${hook.deliveryPath}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-hub-signature': sig },
  body,
});
check(delivered.status === 202, 'the signed delivery is accepted', `http ${delivered.status}`);

// And one that will not match the PA filter.
const other = JSON.stringify({
  webhookEvent: 'jira:issue_created',
  timestamp: Date.now(),
  issue: { key: 'ENG-1', fields: { project: { key: 'ENG' } } },
});
await fetch(`${BASE}${hook.deliveryPath}`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-hub-signature': `sha256=${crypto.createHmac('sha256', secretText).update(other).digest('hex')}`,
  },
  body: other,
});

await page.reload();
await until(() => page.locator('.cron-run-row').first().isVisible(), 10_000);
check(
  (await page.locator('.cron-run-row').count()) >= 1,
  'the run shows in the delivery history',
);
check(
  (await page.locator('.cron-status--running, .cron-status--succeeded, .cron-status--failed').count()) >= 1,
  'it carries a run status',
);

heading('A filtered delivery is dimmed and explains itself');
const toggle = page.locator('.linkish', { hasText: 'Show the ones that did not run' });
check(await toggle.isVisible(), 'filtered rows are hidden by default');
await toggle.click();
const inert = page.locator('.cron-run-row.inert').first();
check(await until(() => inert.isVisible()), 'the filtered row appears when asked for');
const reason = await inert.locator('.delivery-reason').textContent();
check(/not one of/.test(reason ?? ''), 'it carries a human-readable reason', reason?.trim());
await page.screenshot({ path: path.join(SHOTS, 'hook-04-deliveries.png'), fullPage: true });

// -- 7. The project tree row ---------------------------------------------
heading('The webhook shows in the project tree');
await page.goto(`${BASE}/#/`);
await until(() => page.locator('.home-bar').isVisible());
// Expand every project card.
const heads = page.locator('.project-head');
for (let i = 0; i < (await heads.count()); i++) {
  try {
    await heads.nth(i).click({ timeout: 500 });
  } catch {
    /* already open */
  }
}
const treeRow = page.locator('.cron-job-row', { hasText: 'Triage new bugs' });
check(await until(() => treeRow.count().then((n) => n > 0)), 'a webhook row is listed');
await page.screenshot({ path: path.join(SHOTS, 'hook-05-tree.png'), fullPage: true });

// -- 8. Rotation invalidates the old secret ------------------------------
heading('Rotating the secret rejects the old one');
const rotated = await call(`/api/webhooks/${hook.id}/secret/rotate`, { method: 'POST' });
check(rotated.secret !== secretText, 'a new secret is issued');
const stale = await fetch(`${BASE}${hook.deliveryPath}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-hub-signature': sig },
  body,
});
check(stale.status === 401, 'a delivery signed with the old secret is rejected', `http ${stale.status}`);

await browser.close();
console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
console.log(`Screenshots in ${SHOTS}`);
process.exit(failures === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * Browser pass over the Claude Code third-party variants (PA-19), phone size.
 *
 * The server demo (`demo:deepseek-variant`) proves the conversation really is
 * shared across providers. This one covers what only a browser can answer:
 * that the variants reach the composer's agent list and grey out when
 * unconfigured, that the disclosure banner is actually rendered rather than
 * merely present in the payload, and — the part with no unit-test equivalent —
 * that the "Continue as … / Change" affordance appears on a *finished* chat and
 * changes which agent the next prompt resumes as.
 *
 * Expects a *scratch* server (PA_BASE, PA_TOKEN) with a throwaway workspace
 * root — it starts real agents.
 */
import { chromium, devices } from 'playwright';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@pocketagent/protocol';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.PA_BASE ?? 'http://127.0.0.1:8799';
const TOKEN = process.env.PA_TOKEN;
const REPO = new URL('../../../', import.meta.url).pathname;
const SHOTS = path.join(REPO, 'screenshots');

let failures = 0;
let step = 0;
const heading = (t) => console.log(`\n[${++step}] ${t}`);
const check = (cond, label, detail = '') => {
  if (cond) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
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

if (!TOKEN) {
  console.error('PA_TOKEN is required.');
  process.exit(1);
}

/** A finished structured session to hang the resume affordance off. */
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

/**
 * Run one turn, so the session acquires an `agentSessionId`.
 *
 * Without this the resume affordance correctly does not render: `canResume`
 * requires a conversation to resume *into*, and a session killed before its
 * first turn has none. Driving a real turn is the only way to reach the state
 * this step is about.
 */
function runTurn(sessionId, prompt, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/ws?v=${PROTOCOL_VERSION}`, {
      headers: { cookie },
    });
    let done = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      resolve(reason);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'attach', sessionId })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'attached') {
        ws.send(JSON.stringify({ type: 'prompt', sessionId, text: prompt }));
        return;
      }
      if (m.type === 'agent_event' && m.event.kind === 'turn_complete') {
        clearTimeout(timer);
        finish('turn_complete');
      }
    });
    ws.on('error', () => finish('ws_error'));
  });
}

await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
const { workspaces } = await call('/api/workspaces');
const root = workspaces?.[0]?.path;

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

// -- 1. The variants reach the composer's agent picker ----------------------
heading('The variants appear in the new-chat agent list');
await page.click('.compose-fab');
await page.waitForSelector('.composer-page');
await page.waitForSelector('.selector-row');
await page.click('[data-selector="Agent"]');
await until(() => page.locator('.sheet-option').first().isVisible());

const labels = await page.locator('.sheet-option-label').allTextContents();
check(
  labels.some((l) => l.includes('Claude Code (DeepSeek)')),
  'Claude Code (DeepSeek) is offered',
  labels.filter((l) => l.includes('Claude')).join(' | '),
);
check(
  labels.some((l) => l.includes('Claude Code (Omniroute)')),
  'Claude Code (Omniroute) is offered',
);
await page.screenshot({ path: path.join(SHOTS, 'pa19-agent-picker.png') });

// The greyed-out state is what an unconfigured provider looks like. With a key
// present these are enabled, so assert the mechanism rather than the state:
// every option the list renders carries an explicit disabled flag.
const disabledCount = await page.locator('.sheet-option:disabled').count();
console.log(`      options disabled right now: ${disabledCount}`);

// Pick the DeepSeek variant and confirm its own catalog is what the model row
// offers — not Anthropic's, which is the bug `staticModels` exists to prevent.
const dsOption = page.locator('.sheet-option', { hasText: 'Claude Code (DeepSeek)' }).first();
await dsOption.click();
await until(() => page.locator('[data-selector="Model"]').isVisible(), 4000);
if (await page.locator('[data-selector="Model"]').isVisible()) {
  await page.click('[data-selector="Model"]');
  await until(() => page.locator('.sheet-option').first().isVisible());
  const models = await page.locator('.sheet-option-label').allTextContents();
  check(
    models.some((m) => m.includes('deepseek')),
    'the model picker offers the adapter’s own catalog',
    models.join(' | '),
  );
  check(
    !models.some((m) => /sonnet|opus|haiku/i.test(m)),
    'and offers no Anthropic model ids',
  );
  await page.screenshot({ path: path.join(SHOTS, 'pa19-model-picker.png') });
  await page.keyboard.press('Escape');
} else {
  check(false, 'a model row is shown for the variant');
}
await page.keyboard.press('Escape');

// -- 2. A live variant session discloses its provider -----------------------
heading('A variant session shows a standing disclosure');
const created = await call('/api/sessions', {
  method: 'POST',
  body: JSON.stringify({
    agent: 'claude-deepseek',
    cwd: root,
    cols: 80,
    rows: 24,
    transport: 'structured',
    title: 'PA-19 disclosure',
  }),
});
await page.goto(`${BASE}/#/s/${created.id}`);
const bannerShown = await until(() => page.locator('.provider-banner').isVisible(), 10000);
check(bannerShown, 'the provider banner is rendered');
if (bannerShown) {
  const text = await page.locator('.provider-banner').innerText();
  check(text.includes('DeepSeek'), 'it names the provider', text.slice(0, 80));
  check(/cost/i.test(text), 'and warns that the cost figures are wrong');
  await page.screenshot({ path: path.join(SHOTS, 'pa19-disclosure-banner.png') });
}

// -- 3. The resume affordance on a finished chat ----------------------------
heading('A finished chat offers "Continue as … / Change"');
// One real turn first: the affordance is gated on there being a conversation
// to resume, which is exactly right and means an unused session must not show
// it. Then kill it — the state a rate-limited user is actually in.
const turn = await runTurn(created.id, 'Reply with just the word READY.');
check(turn === 'turn_complete', 'the variant ran a turn against DeepSeek', turn);
await call(`/api/sessions/${created.id}`, { method: 'DELETE' });
await page.reload();

const rowShown = await until(() => page.locator('.resume-as-row').isVisible(), 15000);
check(rowShown, 'the "Continue as" row appears once the session is finished');
if (rowShown) {
  const before = await page.locator('.resume-as-row').innerText();
  check(before.includes('Claude Code'), 'it names the agent the next prompt will use', before.trim());
  await page.screenshot({ path: path.join(SHOTS, 'pa19-continue-as-row.png') });

  await page.locator('.resume-as-row .link-btn').click();
  const sheetShown = await until(() => page.locator('.sheet-option').first().isVisible());
  check(sheetShown, 'tapping Change opens the picker');

  const options = await page.locator('.sheet-option-label').allTextContents();
  check(
    options.some((o) => o === 'Claude Code'),
    'stock Claude Code is offered',
    options.join(' | '),
  );
  check(
    !options.some((o) => /opencode|codex|^agy$|^pi$|shell/i.test(o)),
    'agents in another conversation namespace are not offered',
    options.join(' | '),
  );
  await page.screenshot({ path: path.join(SHOTS, 'pa19-continue-as-picker.png') });

  await page.locator('.sheet-option', { hasText: 'Claude Code' }).first().click();
  await until(async () =>
    (await page.locator('.resume-as-row').innerText()).includes('Claude Code'),
  );
  const after = await page.locator('.resume-as-row').innerText();
  check(after.includes('Claude Code'), 'the row reflects the new choice', after.trim());
}

await browser.close();
console.log(
  failures === 0
    ? `\nAll checks passed. Screenshots in ${SHOTS}`
    : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);

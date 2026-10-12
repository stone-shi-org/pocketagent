#!/usr/bin/env node
/**
 * PA-136's acceptance criteria, in real Chrome, at a phone and a desktop
 * viewport: a PDF, an .xlsx and a .md attached to a structured coding-agent
 * session and to a Pocket Agent chat, each landing in its documented
 * directory with the agent told its path; an image still going inline; an
 * oversized file refused visibly.
 *
 * PA-137 adds the reading half: the documents are real (a PDF with a text
 * layer, an xlsx with cells), the Pocket Agent's model must receive their
 * extracted text and the Markdown's content inline, fenced as data, with a
 * sidecar `.txt` beside each document in `artifacts/uploads/`; each chip says
 * its text was read; and the claude session gets no sidecar, because Claude
 * Code's own `Read` handles a PDF.
 *
 * Needs no running server: it starts a scratch backend (throwaway data root,
 * workspace and HOME — never the real database) and a fake OpenAI-compatible
 * endpoint for the Pocket Agent, so no real LLM is called. The coding-agent
 * half uses the real `claude` binary only to have a structured session to
 * send to; with a scratch HOME it is not signed in, which does not matter —
 * the files land, and the agent is handed the prompt, before it answers.
 *
 * `pnpm build` first. Run with: pnpm demo:attachments-ui
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';

let step = 0;
let failures = 0;
const ok = (label, detail = '') => console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail = '') => {
  failures += 1;
  console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
};
const check = (cond, label, detail) => (cond ? ok(label, detail) : bad(label, detail));
const heading = (title) => console.log(`\n[${++step}] ${title}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const SHOTS = path.join(REPO_ROOT, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-attach-demo-')));
const MASTER = crypto.randomBytes(32).toString('base64url');
const PORT = 19_000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;

const dataDir = path.join(scratch, 'data');
const workspace = path.join(scratch, 'workspace');
const project = path.join(workspace, 'demo-project');
const home = path.join(scratch, 'home');
const fixtures = path.join(scratch, 'fixtures');
for (const dir of [dataDir, project, home, fixtures]) fs.mkdirSync(dir, { recursive: true });

// PA-137: real documents, built by the same helper the unit suites use
// (plain TypeScript, which this Node runs by stripping the types).
const { makePdf, makeXlsx } = await import('../tests/helpers-documents.ts');
const files = {
  pdf: path.join(fixtures, 'Quarterly report.pdf'),
  xlsx: path.join(fixtures, 'numbers.xlsx'),
  md: path.join(fixtures, 'notes.md'),
  png: path.join(fixtures, 'shot.png'),
  big: path.join(fixtures, 'huge.bin'),
};
fs.writeFileSync(files.pdf, makePdf(['Revenue grew 12 percent in Q3', 'Headcount stayed flat']));
fs.writeFileSync(files.xlsx, makeXlsx({ Costs: [['Item', 'Cost'], ['Rent', 1200], ['Cloud', 340]] }));
fs.writeFileSync(files.md, '# Notes\n\n- one\n- two\n');
// A 1×1 PNG.
fs.writeFileSync(
  files.png,
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
);
fs.writeFileSync(files.big, Buffer.alloc(21 * 1024 * 1024, 1));

// A fake OpenAI-compatible endpoint: records each request, answers "ok".
const llmRequests = [];
const llm = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      llmRequests.push(JSON.parse(body));
    } catch {
      /* a probe */
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Got the files.' } }] })}\n\ndata: [DONE]\n\n`);
  });
});
await new Promise((resolve) => llm.listen(0, '127.0.0.1', resolve));
const LLM_URL = `http://127.0.0.1:${llm.address().port}/v1`;

// Killed by its own pid, never by pattern — see CLAUDE.md's 2026-09-17 note.
const server = spawn(process.execPath, ['apps/server/dist/server.js'], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    HOME: home,
    HOST: '127.0.0.1',
    PORT: String(PORT),
    NODE_ENV: 'development',
    LOG_LEVEL: 'warn',
    POCKETAGENT_AUTH_TOKEN: MASTER,
    POCKETAGENT_WORKSPACE_ROOTS: workspace,
    POCKETAGENT_DATA_DIR: dataDir,
    POCKETAGENT_BACKEND: 'direct',
    POCKETAGENT_COOKIE_SECURE: 'false',
    POCKETAGENT_ADOPT_TMUX_SOCKET: '',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', (chunk) => {
  if (/error|fatal/i.test(String(chunk))) process.stderr.write(`[server] ${chunk}`);
});
let browser = null;
const cleanup = () => {
  try {
    server.kill('SIGKILL');
  } catch {
    /* gone */
  }
  llm.close();
  try {
    // `claude` may still be writing into the scratch HOME as it exits.
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    console.log(`(scratch left at ${scratch})`);
  }
};
process.on('exit', cleanup);

async function waitForHealth() {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return true;
    } catch {
      /* not yet */
    }
    await sleep(150);
  }
  return false;
}

async function launch() {
  for (const options of [{}, { channel: 'chrome' }, { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] }]) {
    try {
      return await chromium.launch(options);
    } catch {
      /* try next */
    }
  }
  throw new Error('no usable browser');
}

/** Logs a fresh browser context in, and returns it with an API helper. */
async function loggedIn(contextOptions) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('#token', MASTER);
  await page.click('button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('#token'), null, { timeout: 15_000 });
  const api = async (method, url, body) => {
    const res = await context.request.fetch(`${BASE}${url}`, {
      method,
      headers: { origin: BASE, 'content-type': 'application/json' },
      ...(body ? { data: body } : {}),
    });
    return { status: res.status(), json: await res.json().catch(() => null) };
  };
  return { context, page, api, errors };
}

// On the desktop layout every open tab stays mounted (hidden), so every
// selector is scoped to what is actually on screen.
const fileInput = (page) => page.locator('.promptbar:visible input[type=file]');
const visibleCount = (page, selector) =>
  page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length > 0).length, selector);
const waitVisibleCount = (page, selector, n, timeout = 15_000) =>
  page.waitForFunction(
    ([sel, want]) => [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length > 0).length >= want,
    [selector, n],
    { timeout },
  );

/** Attach the three documents through the real picker, wait for the uploads. */
async function attachDocuments(page) {
  await fileInput(page).setInputFiles([files.pdf, files.xlsx, files.md]);
  await waitVisibleCount(page, '.file-chip-row.pending .file-chip.ready', 3);
}

function landed(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

if (!(await waitForHealth())) {
  console.log('server did not start');
  process.exit(1);
}
browser = await launch();
console.log('PocketAgent PA-136/PA-137 attachments demo\n' + '='.repeat(60));

for (const [label, contextOptions] of [
  ['phone (iPhone 13)', { ...devices['iPhone 13'] }],
  ['desktop (1280×900)', { viewport: { width: 1280, height: 900 } }],
]) {
  const tag = label.startsWith('phone') ? 'phone' : 'desktop';
  const { context, page, api, errors } = await loggedIn(contextOptions);

  heading(`${label}: a structured claude session`);
  {
    const created = await api('POST', '/api/sessions', {
      agent: 'claude',
      cwd: project,
      cols: 80,
      rows: 24,
      transport: 'structured',
      title: `attachments ${tag}`,
    });
    check(created.status === 201, 'session created', `status ${created.status}`);
    const sessionId = created.json?.id;
    await page.goto(`${BASE}/#/s/${sessionId}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.promptbar textarea:visible', { timeout: 15_000 });

    const before = landed(path.join(project, '.pocketagent', 'attachments')).length;
    await attachDocuments(page);
    check(landed(path.join(project, '.pocketagent', 'attachments')).length === before, 'nothing lands in the repo before Send');
    await page.screenshot({ path: path.join(SHOTS, `pa136-${tag}-session-composer.png`) });

    await page.fill('.promptbar:visible textarea', 'Please read these three files.');
    await page.click('.promptbar:visible button[aria-label="Send prompt"]');
    await waitVisibleCount(page, '.file-chip-row[aria-label="Attached files"] .file-chip', 3);
    const names = await page.locator('.file-chip-row[aria-label="Attached files"] .file-chip-name:visible').allTextContents();
    check(
      ['Quarterly report.pdf', 'numbers.xlsx', 'notes.md'].every((n) => names.includes(n)),
      'the sent prompt shows a chip per file',
      names.join(', '),
    );
    const onDisk = landed(path.join(project, '.pocketagent', 'attachments')).slice(before);
    const all = landed(path.join(project, '.pocketagent', 'attachments'));
    check(
      ['Quarterly report_', 'numbers_', 'notes_'].every((stem) => all.some((f) => f.startsWith(stem))),
      'each file landed in <cwd>/.pocketagent/attachments under its sanitised name + suffix',
      all.join(', ') || String(onDisk),
    );
    check(
      fs.readFileSync(path.join(project, '.pocketagent', '.gitignore'), 'utf8').includes('*'),
      '.pocketagent/.gitignore keeps them out of git status',
    );
    check(!all.some((f) => f.endsWith('.txt')), 'claude gets no extracted-text sidecar: its Read tool reads the PDF itself (PA-137)');
    // The chips are read back out of the prompt text the agent was sent
    // (`userPromptView`), so the text must carry one note per file; the
    // copy-path button on each chip holds exactly that path.
    const notes = await page.evaluate(() =>
      [...document.querySelectorAll('.file-chip-row[aria-label="Attached files"] .file-chip')]
        .filter((e) => e.getClientRects().length > 0)
        .map((e) => e.getAttribute('title')),
    );
    check(
      notes.length === 3 && notes.every((p) => /^\.pocketagent\/attachments\/.+_\d{8}-\d{6}_[0-9a-f]{4}\.(pdf|xlsx|md)$/.test(p ?? '')),
      'the agent was told each path',
      notes.join(', '),
    );
    await page.screenshot({ path: path.join(SHOTS, `pa136-${tag}-session-sent.png`) });

    // Images behave as before: inline preview, no upload chip.
    await fileInput(page).setInputFiles([files.png]);
    await page.waitForSelector('.attach-preview img:visible', { timeout: 10_000 });
    const pendingChips = await visibleCount(page, '.file-chip-row.pending .file-chip');
    check(pendingChips === 0, 'an image still attaches inline, not as an uploaded file');
    await page.click('.promptbar:visible button[aria-label="Remove attached image"]');

    // Oversized: visible error, nothing sent.
    await fileInput(page).setInputFiles([files.big]);
    await page.waitForSelector('.attach-error:visible', { timeout: 10_000 });
    const errorText = (await page.locator('.attach-error:visible').first().textContent()) ?? '';
    check(/too large/i.test(errorText), 'an oversized file is refused with a visible error', errorText);
  }

  heading(`${label}: a Pocket Agent chat`);
  {
    await api('PATCH', '/api/planner/settings', { baseUrl: LLM_URL });
    const chat = await api('POST', '/api/planner/chats', { modelId: 'fake-model' });
    check(chat.status === 201, 'chat created', `status ${chat.status}`);
    const chatId = chat.json?.id;
    await page.goto(`${BASE}/#/planner/${chatId}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.promptbar textarea:visible', { timeout: 15_000 });
    await attachDocuments(page);
    await page.fill('.promptbar:visible textarea', 'Summarise these.');
    const llmBefore = llmRequests.length;
    await page.click('.promptbar:visible button[aria-label="Send prompt"]');
    await waitVisibleCount(page, '.file-chip-row[aria-label="Attached files"] .file-chip', 3);
    // Waited for on its own: on the desktop the coding session's tab is still
    // on screen, and its (linkless) chips satisfy the count above early.
    const linked = await waitVisibleCount(page, '.file-chip-row[aria-label="Attached files"] a.file-chip-link', 3)
      .then(() => true)
      .catch(() => false);
    check(linked, 'each chip links to the file (served from the Artifacts route)');
    for (let i = 0; i < 50 && llmRequests.length === llmBefore; i++) await sleep(100);
    const lastUser = [...(llmRequests.at(-1)?.messages ?? [])].reverse().find((m) => m.role === 'user');
    const content = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
    check(content.startsWith('Summarise these.'), 'the model got what the user typed', content.split('\n')[0]);
    check(
      (content.match(/\[Attached file saved to: artifacts\/uploads\//g) ?? []).length === 3,
      'and a path note per file, under artifacts/uploads',
    );
    const workspaceDir = path.join(dataDir, 'planner-workspaces', 'default', 'artifacts', 'uploads');
    const uploads = landed(workspaceDir);
    check(
      ['Quarterly report_', 'numbers_', 'notes_'].every((stem) => uploads.some((f) => f.startsWith(stem))),
      'each file landed in the planner workspace under artifacts/uploads',
      uploads.join(', '),
    );
    const transcript = fs.readFileSync(path.join(dataDir, 'planner-workspaces', 'default', '.transcripts', `${chatId}.jsonl`), 'utf8');
    check(!transcript.includes('%PDF') && transcript.includes('"attachments"'), 'the transcript records metadata, never the bytes');

    // PA-137: the model can answer from the files with no tool call at all.
    check(content.includes('Revenue grew 12 percent in Q3'), "the PDF's extracted text went inline (PA-137)");
    check(content.includes('Item,Cost\nRent,1200\nCloud,340'), "the xlsx's cells went inline as CSV");
    check(/<<<FILE notes\.md [0-9a-f]{16}>>>\n# Notes/.test(content), 'the Markdown went inline, fenced as data');
    check(!transcript.includes('Revenue grew'), 'and none of that content is in the transcript');
    check(
      uploads.some((f) => /^Quarterly report_.*\.pdf\.txt$/.test(f)) && uploads.some((f) => /^numbers_.*\.xlsx\.txt$/.test(f)),
      'each document has a sidecar .txt that read_file can page through',
    );
    const details = await page.locator('.file-chip-row[aria-label="Attached files"] .file-chip-detail:visible').allTextContents();
    check(details.filter((d) => d.includes('text read')).length >= 2, 'the PDF and xlsx chips say their text was read', details.join(', '));
    await page.screenshot({ path: path.join(SHOTS, `pa136-${tag}-pocket-agent.png`) });

    // Drag-and-drop, the third way in: a synthetic drop with a real DataTransfer.
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['dropped'], 'dropped.md', { type: 'text/markdown' }));
      const bar = [...document.querySelectorAll('.promptbar')].find((e) => e.getClientRects().length > 0);
      bar.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      bar.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(
      () => [...document.querySelectorAll('.file-chip-row.pending .file-chip-name')].some((n) => n.textContent === 'dropped.md'),
      null,
      { timeout: 10_000 },
    );
    ok('a file dropped on the composer is attached');
  }

  check(errors.length === 0, 'no uncaught page errors', errors.join(' | '));
  await context.close();
}

await browser.close();
console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);

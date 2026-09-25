#!/usr/bin/env node
/**
 * PA-96: Gemini Live in a Pocket Agent chat, end to end, against the real
 * service, in real Chrome at phone size.
 *
 * The unit suites cover everything the server *decides* (the token's
 * constraint set, the tool gate, the transcript shape) and the pure wire
 * mapping. What only this can show is the whole loop with real audio: a real
 * spoken request goes in through the browser's microphone path, Gemini hears
 * it and calls a planner tool, the call parks on the on-screen approval card,
 * a human taps "Allow once", the tool runs server-side, Gemini is told and
 * answers out loud — and the chat's own transcript ends up holding all of it
 * as ordinary events.
 *
 * The microphone is Chrome's fake capture device fed a WAV this script
 * synthesises with Gemini's TTS model (`--use-file-for-fake-audio-capture`),
 * padded with silence because Chrome loops the file.
 *
 * Expects a *scratch* server (PA_BASE, PA_TOKEN) started with
 * `POCKETAGENT_SETTINGS_ENC_KEY` and its own `POCKETAGENT_DATA_DIR`, plus
 * `PA_GEMINI_KEY` (an AI Studio key) here. It stores that key on the scratch
 * server, switches the default Pocket Agent to Gemini Live, and switches it
 * back and removes the key at the end.
 */
import { chromium, devices } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.PA_BASE ?? 'http://127.0.0.1:8799';
const TOKEN = process.env.PA_TOKEN;
const GEMINI_KEY = process.env.PA_GEMINI_KEY;
const REPO = new URL('../../../', import.meta.url).pathname;
const SHOTS = path.join(REPO, 'screenshots');
const FOLDER = 'gemini-demo';

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

async function until(predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      if (await predicate()) return true;
    } catch {
      /* not there yet */
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

if (!TOKEN || !GEMINI_KEY) {
  console.error('PA_TOKEN and PA_GEMINI_KEY are required.');
  process.exit(1);
}
fs.mkdirSync(SHOTS, { recursive: true });

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
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

/** A spoken request as a WAV Chrome can use as its microphone. */
async function synthesiseSpeech(text) {
  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
        },
      }),
    },
  );
  const json = await res.json();
  const data = json?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData?.data;
  if (!data) throw new Error(`TTS failed: ${JSON.stringify(json).slice(0, 300)}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa96-'));
  const raw = path.join(dir, 'speech.pcm');
  const wav = path.join(dir, 'speech.wav');
  fs.writeFileSync(raw, Buffer.from(data, 'base64'));
  // 1s of lead-in silence, the request, then 120s of silence so Chrome's
  // looping of the file does not ask twice during the run.
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', raw,
    '-af', 'adelay=1000,apad=pad_dur=120',
    '-ar', '48000', wav,
  ]);
  return wav;
}

// ---- 0. set up the scratch server --------------------------------------------

heading('Configure Gemini Live on the scratch server');
await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
const saved = await call('/api/planner/gemini-live', { method: 'PATCH', body: JSON.stringify({ apiKey: GEMINI_KEY }) });
check(saved.status === 200 && saved.body?.available === true, 'stored the Gemini key (encrypted)', `status ${saved.status}`);
check(!JSON.stringify(saved.body).includes(GEMINI_KEY), 'the key is not echoed back');

const { body: wsList } = await call('/api/planner/workspaces');
const agent = wsList.workspaces.find((w) => w.isDefault) ?? wsList.workspaces[0];
const originalIdentity = agent.identityPrompt;
await call(`/api/planner/workspaces/${agent.id}`, {
  method: 'PATCH',
  body: JSON.stringify({
    liveProvider: 'gemini-live',
    identityPrompt:
      `Your own scratch directory is ${agent.path}. When asked to create a folder, create it inside ` +
      'that directory with the mkdir tool, naming it exactly as asked with words joined by hyphens.',
  }),
});
const target = path.join(agent.path, FOLDER);
fs.rmSync(target, { recursive: true, force: true });
const { body: chat } = await call('/api/planner/chats', { method: 'POST', body: JSON.stringify({ workspaceId: agent.id }) });
check(typeof chat?.id === 'string', 'created a chat in that agent', chat?.id);

const wav = await synthesiseSpeech('Please create a new folder called gemini demo.');
check(fs.existsSync(wav), 'synthesised the spoken request with Gemini TTS', wav);

// ---- 1. the browser ------------------------------------------------------------

const browser = await chromium.launch({
  executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined,
  args: [
    '--no-sandbox',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext({ ...devices['Pixel 7'], hasTouch: true });
await context.grantPermissions(['microphone'], { origin: BASE });
const page = await context.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`  [console] ${m.text()}`);
});
// Watch the page's own traffic: the key must never reach it, and the token
// must come from our server, not be typed anywhere.
const pageTraffic = [];
page.on('response', async (res) => {
  if (!res.url().startsWith(BASE)) return;
  try {
    pageTraffic.push(await res.text());
  } catch {
    /* body unavailable */
  }
});
const sockets = [];
page.on('websocket', (ws) => sockets.push(ws.url()));

await page.goto(BASE);
await page.fill('input[type="password"]', TOKEN);
await page.click('button[type="submit"]');
await until(() => page.locator('.home-bar').isVisible());

heading('The chat discloses Gemini Live on every visit');
await page.goto(`${BASE}/#/planner/${chat.id}`);
const disclosed = await until(() => page.locator('.planner-gemini-disclosure').isVisible());
check(disclosed, 'the disclosure callout is rendered');
check(
  (await page.locator('.planner-gemini-disclosure').innerText()).includes('sent to Google'),
  'it says voice and tool results go to Google',
);
await page.screenshot({ path: path.join(SHOTS, 'pa96-1-disclosure.png') });

heading('Live mode connects straight to Google with a minted token');
await page.click('button[aria-label="Turn on Gemini Live"]');
const listening = await until(() => page.locator('.planner-gemini-strip-state', { hasText: 'listening' }).isVisible(), 15000);
check(listening, 'the strip reads "Gemini Live · listening"');
const geminiSocket = sockets.find((u) => u.includes('BidiGenerateContentConstrained'));
check(!!geminiSocket, 'the browser opened the *constrained* Gemini endpoint');
check(!!geminiSocket && geminiSocket.includes('access_token=auth_tokens'), 'authenticated by an ephemeral token');
check(!!geminiSocket && !geminiSocket.includes(GEMINI_KEY), 'the API key is not on the socket URL');
await page.screenshot({ path: path.join(SHOTS, 'pa96-2-listening.png') });

heading('Gemini hears the request and calls mkdir, which parks on the approval card');
const heard = await until(() => page.locator('.planner-gemini-strip-line', { hasText: /folder/i }).isVisible(), 30000);
check(heard, 'the strip shows what Gemini heard');
const cardShown = await until(() => page.getByRole('button', { name: 'Allow once' }).isVisible(), 45000);
check(cardShown, 'the approval card is on screen');
// The path Gemini actually asked for (it may spell the name its own way).
const pendingHist = (await call(`/api/planner/chats/${chat.id}/history`)).body.events;
const requested = pendingHist.find((e) => e.kind === 'tool_use' && e.name === 'mkdir')?.input?.path;
check(typeof requested === 'string' && requested.startsWith(agent.path), 'mkdir targets the agent’s own directory', requested);
const madePath = typeof requested === 'string' ? requested : target;
check(!fs.existsSync(madePath), 'nothing ran before the human decided');
await page.screenshot({ path: path.join(SHOTS, 'pa96-3-approval.png') });

heading('Allow once: the tool runs server-side and Gemini is told');
await page.getByRole('button', { name: 'Allow once' }).click();
const made = await until(() => fs.existsSync(madePath), 15000);
check(made, `the folder exists: ${madePath}`);
// Gemini answers the relayed outcome out loud; its transcription is what gets
// persisted as the reply.
const replied = await until(async () => {
  const { body } = await call(`/api/planner/chats/${chat.id}/history`);
  const kinds = body.events.map((e) => e.kind);
  const lastResult = kinds.lastIndexOf('tool_result');
  return lastResult >= 0 && kinds.slice(lastResult).includes('text');
}, 45000);
check(replied, 'Gemini spoke about the result after the approval');
await page.screenshot({ path: path.join(SHOTS, 'pa96-4-after.png') });

heading('A typed message goes to Gemini while live');
const box = page.locator('textarea').first();
await box.fill('Reply with just the word pineapple.');
await box.press('Enter');
const typedAnswered = await until(async () => {
  const { body } = await call(`/api/planner/chats/${chat.id}/history`);
  return body.events.some((e) => e.kind === 'text' && /pineapple/i.test(e.text));
}, 40000);
check(typedAnswered, 'Gemini answered the typed message, and it was persisted');

heading('Turn live mode off');
await page.click('button[aria-label="Turn off Gemini Live"]');
check(await until(() => page.locator('.planner-gemini-strip').isHidden()), 'the strip is gone');

heading('The chat transcript holds the whole exchange as ordinary events');
const { body: hist } = await call(`/api/planner/chats/${chat.id}/history`);
const kinds = hist.events.map((e) => e.kind);
console.log(`  events: ${kinds.join(', ')}`);
const firstUser = hist.events.find((e) => e.kind === 'user_prompt');
check(!!firstUser && /folder/i.test(firstUser.text), 'the spoken request is a user_prompt', firstUser?.text);
const use = hist.events.find((e) => e.kind === 'tool_use' && e.name === 'mkdir');
check(!!use, 'mkdir was recorded as a tool_use');
check(kinds.includes('permission_request') && kinds.includes('permission_resolved'), 'the approval is in the record');
const result = hist.events.find((e) => e.kind === 'tool_result' && e.toolUseId === use?.id);
check(!!result && !result.isError, 'and its successful tool_result');
const footer = hist.events.find((e) => e.kind === 'turn_complete' && e.inputTokens);
check(!!footer, 'turns closed with Gemini’s token counts', footer ? `${footer.inputTokens} in / ${footer.outputTokens} out` : '');
const { body: chats } = await call('/api/planner/chats');
check(!!chats.chats.find((c) => c.id === chat.id)?.title, 'the chat titled itself from the first thing heard');

heading('The key never reached the page');
check(!pageTraffic.some((t) => t.includes(GEMINI_KEY)), 'no response from this server carried the key', `${pageTraffic.length} responses`);

// ---- cleanup -------------------------------------------------------------------
await browser.close();
await call(`/api/planner/workspaces/${agent.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ liveProvider: 'pipeline', identityPrompt: originalIdentity }),
});
await call('/api/planner/gemini-live', { method: 'PATCH', body: JSON.stringify({ clearApiKey: true }) });
fs.rmSync(madePath, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`} — screenshots in ${SHOTS}`);
process.exit(failures === 0 ? 0 : 1);

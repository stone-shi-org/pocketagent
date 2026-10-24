#!/usr/bin/env node
/**
 * PA-134's acceptance criteria, against real processes and real Chrome.
 *
 * Needs no running server and no PA_BASE: like `provision-demo.mjs` it starts
 * two real backends and a real Hub itself, each with a throwaway data root and
 * HOME, binds them through the real handshake, and kills them by pid at the end.
 * A fake OpenAI-compatible endpoint stands in for both Pocket Agents' LLMs, so
 * no model is called; it plays the coordinator by reading the real tool results
 * the Hub sends back, so routing is decided from what the hosts actually report.
 *
 * What it demonstrates, in order:
 *   1. The Fleet agent is enabled from the Hub page in Chrome; every host gets a
 *      scoped pam_ token (read, sessions, planner — never admin), checked on each
 *      backend's own API; the coordinator's registry really reaches the Hub /mcp.
 *   2. The Hub's phm_ token is a 401 everywhere on the Hub except /mcp.
 *   3. "Build the iOS app" in the Fleet chat reads both hosts' capabilities and
 *      routes to mac01, the host with the Xcode Pocket Agent. (A real platform
 *      card is PA-133's; until then `platform` is the host's true one, and this
 *      demo routes on the agent that host advertises.)
 *   4. The dispatch stops for approval on the coordinator, offering "this agent
 *      and target" but never "globally".
 *   5. The target's own approval arrives as a real Web Push through the Hub's
 *      relay — decrypted here (RFC 8291) — with a /#/h/mac01/planner/… deep
 *      link, and is answered there in a second tab.
 *   6. The coordinator's wait sees `complete`.
 *   7. PA-169: a Hub MCP client token is created on the Hub page, limited to
 *      mac01 and shown once with a copyable config; a real MCP SDK client (what
 *      a coding agent is) lists only mac01, is refused on dev01 naming it,
 *      dispatches to mac01 itself, and the target's approval arrives by push.
 *      Revoking the token on the page stops its very next call.
 *   8. PA-171: dev01's webhooks are allowed to dispatch to mac01 on the Hub. One
 *      Jira webhook on dev01 — PA → dev01's own folder, XY → mac01 — runs PA
 *      locally and XY on mac01, from one URL. A Pocket Agent webhook routed to
 *      mac01 parks on mac01's approval (its delivery stays `running`), the
 *      approval arrives by push deep-linked to mac01, is answered there, and
 *      the delivery settles `succeeded`; the issue's next delivery continues
 *      the same chat on mac01. Routing switched off, and the Hub down, each
 *      fail a delivery with its own reason and never run it on dev01.
 *   9. The phone viewport shows the Fleet card and the host sheet's Fleet entry.
 *
 * `pnpm build` first. Run with: pnpm demo:fleet
 */
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import { HUB_FLEET_TOOL_NAMES, JIRA_SAMPLE_PAYLOAD } from '@pocketagent/protocol';

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
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-fleet-demo-')));
const shots = path.join(scratch, 'shots');
fs.mkdirSync(shots, { recursive: true });
const children = [];

const token = () => crypto.randomBytes(32).toString('base64url');
const HUB_TOKEN = token();
const BACKEND_TOKENS = { dev01: token(), mac01: token() };

function cleanup() {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
process.on('exit', cleanup);

async function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, label, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  bad(`${label} never became healthy`);
  return false;
}

// ---- A fake LLM that plays both Pocket Agents ---------------------------------

let fleetRegistryId = null;
const llmLog = [];

function sseText(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
}

function sseTool(res, name, args) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const id = `call_${crypto.randomBytes(4).toString('hex')}`;
  const chunk = { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] };
  res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
}

/** Tool results since the last user message, parsed where they are JSON. */
function toolResultsSinceUser(messages) {
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  return messages
    .slice(lastUser + 1)
    .filter((m) => m.role === 'tool')
    .map((m) => {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      try {
        return JSON.parse(text);
      } catch {
        return { text };
      }
    });
}

const hubTool = (tool, args) => ({ tool: `mcp__${fleetRegistryId}__${tool}`, arguments: args });

/**
 * The coordinator. Reads both hosts' capabilities, picks the one that has an
 * Xcode Pocket Agent, dispatches there, then waits until the work is done.
 */
async function coordinator(body, res) {
  const results = toolResultsSinceUser(body.messages ?? []);
  if (results.length === 0) return sseTool(res, 'call_mcp_tool', hubTool('get_host_capabilities', { host: 'dev01' }));
  if (results.length === 1) return sseTool(res, 'call_mcp_tool', hubTool('get_host_capabilities', { host: 'mac01' }));
  if (results.length === 2) {
    const target = results.find((r) => (r.pocketAgents ?? []).some((p) => /xcode/i.test(p.name)));
    if (!target) return sseText(res, 'No host can build an iOS app.');
    const agent = target.pocketAgents.find((p) => /xcode/i.test(p.name));
    return sseTool(
      res,
      'call_mcp_tool',
      hubTool('dispatch_pocket_task', { host: target.host, pocketAgentId: agent.id, prompt: 'Build the iOS app.' }),
    );
  }
  const last = results[results.length - 1];
  const dispatched = results.find((r) => typeof r.ref === 'string');
  if (last.state === 'complete') {
    return sseText(res, `The iOS build finished on ${dispatched.host} (state: complete).`);
  }
  if (last.state === 'ended') return sseText(res, 'The task ended without finishing.');
  // still_running, queued or awaiting_approval: give the human a moment, wait again.
  await sleep(1500);
  return sseTool(res, 'call_mcp_tool', hubTool('wait', { host: dispatched.host, ref: dispatched.ref, timeoutSeconds: 10 }));
}

/** The Xcode agent on mac01: writes a build log (which needs approval), then reports. */
function worker(body, res) {
  const results = toolResultsSinceUser(body.messages ?? []);
  if (results.length === 0) {
    return sseTool(res, 'write_file', { path: 'build-log.md', content: '** BUILD SUCCEEDED ** MyApp.xcodeproj\n' });
  }
  return sseText(res, 'Built MyApp and wrote build-log.md.');
}

const llm = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* a probe */
    }
    llmLog.push(body.model);
    if (body.model === 'coordinator-model') void coordinator(body, res);
    else if (body.model === 'worker-model') worker(body, res);
    else sseText(res, 'ok');
  });
});

// ---- A fake Web Push service that decrypts what it receives ---------------------

const pushKeys = crypto.createECDH('prime256v1');
pushKeys.generateKeys();
const pushAuth = crypto.randomBytes(16);
const pushReceived = [];

/** RFC 8291 / RFC 8188 (aes128gcm), the receiving half. */
function decryptPush(body) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const uaPublic = pushKeys.getPublicKey();
  const ecdhSecret = pushKeys.computeSecret(asPublic);
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const prkKey = hmac(pushAuth, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  const end = padded.lastIndexOf(2);
  return JSON.parse(padded.subarray(0, end).toString('utf8'));
}

function startPushService(port) {
  const certDir = path.join(scratch, 'push-tls');
  fs.mkdirSync(certDir);
  const key = path.join(certDir, 'key.pem');
  const cert = path.join(certDir, 'cert.pem');
  // A self-signed certificate for 127.0.0.1, trusted by the Hub process only
  // (NODE_EXTRA_CA_CERTS) — verification stays on.
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        pushReceived.push(decryptPush(Buffer.concat(chunks)));
      } catch (err) {
        pushReceived.push({ error: err.message });
      }
      res.writeHead(201).end();
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, cert })));
}

// ---- Processes -------------------------------------------------------------------

/** Collect a child's stdout as whole lines (a JSON log line can span chunks). */
function lineCollector(stream) {
  const lines = [];
  let rest = '';
  stream.on('data', (chunk) => {
    const parts = (rest + String(chunk)).split('\n');
    rest = parts.pop() ?? '';
    lines.push(...parts.filter(Boolean));
  });
  return lines;
}

function startBackend(id, port) {
  const dirs = Object.fromEntries(['data', 'workspace', 'home'].map((d) => [d, path.join(scratch, id, d)]));
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const child = spawn(process.execPath, ['apps/server/dist/server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: dirs.home,
      HOST: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'development',
      LOG_LEVEL: 'warn',
      POCKETAGENT_AUTH_TOKEN: BACKEND_TOKENS[id],
      POCKETAGENT_WORKSPACE_ROOTS: dirs.workspace,
      POCKETAGENT_DATA_DIR: dirs.data,
      POCKETAGENT_BACKEND: 'direct',
      POCKETAGENT_COOKIE_SECURE: 'false',
      POCKETAGENT_ADOPT_TMUX_SOCKET: '',
      // A bearer-auth MCP registry (the coordinator's route to the Hub) needs it.
      POCKETAGENT_SETTINGS_ENC_KEY: crypto.randomBytes(32).toString('base64'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = lineCollector(child.stdout);
  child.stderr.on('data', (chunk) => {
    if (/error|fatal/i.test(String(chunk))) process.stderr.write(`[${id}] ${chunk}`);
  });
  children.push(child);
  return { id, baseUrl: `http://127.0.0.1:${port}`, lines, child };
}

function startHub(port, extraCa) {
  const dataDir = path.join(scratch, 'hub');
  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, ['apps/hub/dist/server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      NODE_EXTRA_CA_CERTS: extraCa,
      POCKETAGENT_HUB_HOST: '127.0.0.1',
      POCKETAGENT_HUB_PORT: String(port),
      POCKETAGENT_HUB_AUTH_TOKEN: HUB_TOKEN,
      POCKETAGENT_HUB_DATA_DIR: dataDir,
      POCKETAGENT_HUB_MDNS: 'false',
      POCKETAGENT_SETTINGS_ENC_KEY: crypto.randomBytes(32).toString('base64'),
      POCKETAGENT_COOKIE_SECURE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = lineCollector(child.stdout);
  child.stderr.on('data', (chunk) => {
    if (/error|fatal/i.test(String(chunk))) process.stderr.write(`[hub] ${chunk}`);
  });
  children.push(child);
  return { baseUrl: `http://127.0.0.1:${port}`, lines, child };
}

let hubCookie = '';
let HUB = '';
async function hub(urlPath, init = {}) {
  const response = await fetch(HUB + urlPath, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(hubCookie ? { cookie: hubCookie } : {}),
      ...init.headers,
    },
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) hubCookie = setCookie.split(';')[0];
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

const backendCookies = {};
async function onBackend(backend, method, urlPath, body) {
  if (!backendCookies[backend.id]) {
    const login = await fetch(`${backend.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: BACKEND_TOKENS[backend.id] }),
    });
    backendCookies[backend.id] = (login.headers.get('set-cookie') ?? '').split(';')[0];
  }
  const response = await fetch(`${backend.baseUrl}${urlPath}`, {
    method,
    headers: {
      cookie: backendCookies[backend.id],
      origin: backend.baseUrl,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

async function launch() {
  for (const options of [{}, { channel: 'chrome' }, { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] }]) {
    try {
      return await chromium.launch(options);
    } catch {
      /* next */
    }
  }
  throw new Error('no usable Chromium');
}

async function login(page) {
  await page.goto(HUB, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="password"]', HUB_TOKEN);
  await page.press('input[type="password"]', 'Enter');
  await page.waitForLoadState('networkidle');
}

async function waitFor(fn, timeoutMs = 30_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

// ---------------------------------------------------------------------------------

async function main() {
  console.log('PA-134 — the Fleet agent, against real processes and real Chrome');
  console.log(`scratch: ${scratch}`);

  heading('Start a fake LLM, a fake push service, two backends and a Hub');
  const [llmPort, pushPort, devPort, macPort, hubPort] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
  await new Promise((resolve) => llm.listen(llmPort, '127.0.0.1', resolve));
  const pushService = await startPushService(pushPort);
  const dev01 = startBackend('dev01', devPort);
  const mac01 = startBackend('mac01', macPort);
  const hubProc = startHub(hubPort, pushService.cert);
  HUB = hubProc.baseUrl;
  const up = await Promise.all([waitForHealth(dev01.baseUrl, 'dev01'), waitForHealth(mac01.baseUrl, 'mac01'), waitForHealth(HUB, 'hub')]);
  if (up.some((v) => !v)) throw new Error('a process never came up');
  ok('five processes up', `hub ${HUB}`);

  heading('Configure both hosts’ Pocket Agents, and the Xcode agent on mac01');
  for (const [backend, model] of [[dev01, 'coordinator-model'], [mac01, 'worker-model']]) {
    await onBackend(backend, 'PATCH', '/api/planner/settings', { baseUrl: `http://127.0.0.1:${llmPort}/v1` });
    const created = await onBackend(backend, 'POST', '/api/planner/models', { modelId: model, label: model });
    check(created.status === 201, `${backend.id}: model ${model}`, String(created.status));
  }
  const xcode = await onBackend(mac01, 'POST', '/api/planner/workspaces', { name: 'iOS builder (Xcode)' });
  await onBackend(mac01, 'PATCH', `/api/planner/workspaces/${xcode.body.id}`, { defaultModelId: 'worker-model' });
  check(typeof xcode.body?.id === 'string', 'mac01 has an "iOS builder (Xcode)" Pocket Agent');

  heading('Bind both hosts, and subscribe a (fake) browser to the Hub’s push');
  await hub('/api/auth/login', { method: 'POST', body: JSON.stringify({ token: HUB_TOKEN }) });
  for (const backend of [dev01, mac01]) {
    await hub('/api/hub/hosts', { method: 'POST', body: JSON.stringify({ id: backend.id, label: backend.id, baseUrl: backend.baseUrl }) });
    const bound = await hub(`/api/hub/hosts/${backend.id}/bind`, {
      method: 'POST',
      body: JSON.stringify({ token: BACKEND_TOKENS[backend.id], label: 'fleet demo hub' }),
    });
    check(bound.status === 200, `${backend.id} bound`, bound.body?.error?.message ?? '');
  }
  const subscribed = await hub('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({
      subscription: {
        endpoint: `https://127.0.0.1:${pushPort}/push/demo`,
        keys: { p256dh: pushKeys.getPublicKey().toString('base64url'), auth: pushAuth.toString('base64url') },
      },
    }),
  });
  check(subscribed.status === 200, 'push subscription registered on the Hub', JSON.stringify(subscribed.body));

  const browser = await launch();
  const desktopContext = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const desktop = await desktopContext.newPage();
  await login(desktop);

  heading('Criterion — enable the Fleet agent from the Hub page');
  await desktop.goto(`${HUB}/#/hub`, { waitUntil: 'networkidle' });
  await desktop.waitForSelector('#hub-fleet-heading');
  await desktop.selectOption('.fleet-card select', 'dev01');
  check((await desktop.inputValue('.fleet-card input[type="url"]')) === HUB, 'Hub address prefilled with this browser’s origin');
  await desktop.click('.fleet-card button:has-text("Enable")');
  await desktop.waitForSelector('.dialog .confirm-body');
  const confirmText = await desktop.textContent('.dialog .confirm-body');
  check(/never admin/.test(confirmText ?? ''), 'the confirmation names the token scopes before anything is written');
  await desktop.click('.dialog button:has-text("Enable")');
  await desktop.waitForSelector('.fleet-card strong:has-text("Runs on dev01")', { timeout: 30_000 });
  await desktop.screenshot({ path: path.join(shots, '1-fleet-enabled.png') });
  ok('the card reads "Runs on dev01"');

  const fleet = (await hub('/api/hub/fleet')).body;
  fleetRegistryId = fleet.registryId;
  check(fleet.hosts.every((h) => h.state === 'ok'), 'a dispatch token is held for every host', JSON.stringify(fleet.hosts.map((h) => h.state)));
  for (const backend of [dev01, mac01]) {
    const tokens = (await onBackend(backend, 'GET', '/api/mcp/tokens')).body.clients;
    const scopes = tokens.map((t) => [...t.scopes].sort().join(','));
    check(
      tokens.length === 1 && scopes[0] === 'planner,read,sessions',
      `${backend.id}'s own API lists one token: read, sessions, planner — no admin`,
      JSON.stringify(scopes),
    );
  }
  const registries = (await onBackend(dev01, 'GET', '/api/mcp-registries')).body.registries;
  const reg = registries.find((r) => r.id === fleetRegistryId);
  check(
    reg && reg.lastError === null && reg.toolCount === HUB_FLEET_TOOL_NAMES.length,
    `dev01’s registry reached the Hub /mcp and lists all ${HUB_FLEET_TOOL_NAMES.length} Fleet tools (a coordinator holds every scope)`,
    JSON.stringify({ toolCount: reg?.toolCount, lastError: reg?.lastError }),
  );
  // pino writes through a worker thread; give the line a moment to land.
  const audited = await waitFor(
    () => dev01.lines.some((line) => /mcp client token minted/.test(line) && /"by":"hub:/.test(line)),
    5_000,
  );
  check(
    audited,
    'dev01 audited the token mint, naming the Hub as the principal',
    audited ? '' : dev01.lines.filter((l) => /minted/.test(l)).slice(0, 3).join(' | ') || `(${dev01.lines.length} lines)`,
  );
  // The operator picks the Fleet agent's model, as they would in its editor.
  await onBackend(dev01, 'PATCH', `/api/planner/workspaces/${fleet.pocketAgentId}`, { defaultModelId: 'coordinator-model' });

  heading('Criterion — a phm_ token is a 401 everywhere but /mcp');
  // The coordinator's token is never readable; the demo cannot have it either.
  // Prove the rule with the shape: any phm_ bearer on these paths is refused.
  for (const p of ['/api/hub/hosts', '/api/hub/fleet', '/h/dev01/api/projects', '/api/push/status']) {
    const res = await fetch(`${HUB}${p}`, { headers: { authorization: 'Bearer phm_anything' } });
    check(res.status === 401, `${p} → ${res.status}`);
  }
  const mcpNoToken = await fetch(`${HUB}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check(mcpNoToken.status === 401, `/mcp without a token → ${mcpNoToken.status}`);

  heading('Criterion — "Build the iOS app" in the Fleet chat');
  await desktop.goto(`${HUB}/#/hub`, { waitUntil: 'domcontentloaded' });
  await desktop.click('.hub-nav-item:has-text("Fleet")');
  // dev01 is the Hub's default host, whose routes stay bare (`#/planner/…`).
  await desktop.waitForURL(/#\/(h\/dev01\/)?planner\//, { timeout: 15_000 });
  ok('the sidebar’s Fleet entry opened the chat on the coordinator', desktop.url().replace(HUB, ''));
  await desktop.waitForSelector('.promptbar textarea:visible', { timeout: 15_000 });
  await desktop.fill('.promptbar:visible textarea', 'Build the iOS app.');
  await desktop.click('.promptbar:visible button[aria-label="Send prompt"]');
  await desktop.waitForSelector('.planner-approval-card', { timeout: 30_000 });
  const buttons = await desktop.$$eval('.planner-approval-card button', (nodes) => nodes.map((n) => n.textContent.trim()));
  const title = await desktop.textContent('.planner-approval-title');
  check(/dispatch_pocket_task/.test(title ?? '') && /mac01/.test(title ?? ''), 'it routed to mac01 and stopped for approval here', title?.trim());
  check(
    buttons.includes('Allow once') && buttons.includes('Allow for this agent and target') && !buttons.includes('Allow globally'),
    'offers "this agent and target", never "globally"',
    JSON.stringify(buttons),
  );
  await desktop.screenshot({ path: path.join(shots, '2-dispatch-approval.png') });
  const pushesBefore = pushReceived.length;
  await desktop.click('.planner-approval-card button:has-text("Allow once")');

  heading('Criterion — the target’s approval arrives as a push deep link, and is answered there');
  const pushed = await waitFor(
    () => pushReceived.slice(pushesBefore).find((p) => typeof p.url === 'string' && p.url.includes('/planner/')),
    30_000,
  );
  check(Boolean(pushed), 'a Web Push arrived through the Hub relay', JSON.stringify(pushed));
  check(pushed?.url?.startsWith('/#/h/mac01/planner/'), 'its deep link names mac01', pushed?.url);
  check(/^\[mac01\]/.test(pushed?.title ?? ''), 'its title is prefixed with the host', pushed?.title);
  check(!JSON.stringify(pushed ?? {}).includes('write_file'), 'it says "approval needed", not what the tool is');
  const target = await desktopContext.newPage();
  await target.goto(`${HUB}${pushed.url}`, { waitUntil: 'domcontentloaded' });
  await target.waitForSelector('.planner-approval-card', { timeout: 20_000 });
  const targetTitle = await target.textContent('.planner-approval-title');
  check(/write_file/.test(targetTitle ?? ''), 'the deep link opens mac01’s approval', targetTitle?.trim());
  await target.screenshot({ path: path.join(shots, '3-target-approval.png') });
  await target.click('.planner-approval-card button:has-text("Allow once")');

  heading('Criterion — the coordinator sees `complete`');
  const finished = await desktop
    .waitForSelector('text=The iOS build finished on mac01 (state: complete).', { timeout: 60_000 })
    .then(() => true)
    .catch(() => false);
  check(finished, 'the Fleet chat reports the build finished on mac01');
  const built = fs.existsSync(path.join(scratch, 'mac01', 'data', 'planner-workspaces'))
    && execFileSync('find', [path.join(scratch, 'mac01', 'data', 'planner-workspaces'), '-name', 'build-log.md']).toString().trim();
  check(Boolean(built), 'mac01 wrote build-log.md after a human approved it there', built);
  await desktop.screenshot({ path: path.join(shots, '4-complete.png') });
  await sleep(1000);
  const hubToolLines = hubProc.lines.filter((line) => /hub mcp tool call/.test(line));
  const perTool = {};
  for (const line of hubToolLines) {
    const name = /"tool":"([a-z_]+)"/.exec(line)?.[1] ?? '?';
    perTool[name] = (perTool[name] ?? 0) + 1;
  }
  check(
    (perTool.get_host_capabilities ?? 0) >= 2 && perTool.dispatch_pocket_task === 1 && (perTool.wait ?? 0) >= 1,
    'the Hub logged every Fleet tool call (name, principal, target host, outcome)',
    JSON.stringify(perTool),
  );
  check(!hubToolLines.some((line) => /Build the iOS app/.test(line)), 'the Hub’s log never carries a prompt');

  heading('PA-169 — a coding agent’s own Hub MCP client token, limited to mac01');
  await desktop.goto(`${HUB}/#/hub`, { waitUntil: 'domcontentloaded' });
  const card = 'section[aria-labelledby="hub-mcp-clients-heading"]';
  await desktop.waitForSelector(`${card} #hub-mcp-client-label`);
  await desktop.fill(`${card} #hub-mcp-client-label`, 'laptop claude');
  await desktop.click(`${card} label:has-text("Every host, including") input`);
  await desktop.click(`${card} label.planner-checkbox-row:has-text("mac01") input`);
  await desktop.click(`${card} button:has-text("Create token")`);
  await desktop.waitForSelector(`${card} [role="status"] pre code`);
  const clientToken = ((await desktop.textContent(`${card} [role="status"] .endpoint-url code`)) ?? '').trim();
  const snippet = (await desktop.textContent(`${card} [role="status"] pre code`)) ?? '';
  check(clientToken.startsWith('phm_'), 'the token is shown once on the page', `${clientToken.slice(0, 12)}…`);
  check(snippet.includes(`${HUB}/mcp`) && snippet.includes(`Bearer ${clientToken}`), 'with a ready-to-paste mcpServers config');
  check((await desktop.$$(`${card} [role="status"] button[aria-label="Copy config"]`)).length === 1, 'and a Copy config button');
  await desktop.screenshot({ path: path.join(shots, '5-mcp-client-token.png') });
  const listed = (await hub('/api/hub/mcp/tokens')).body;
  const row = listed.tokens.find((t) => t.label === 'laptop claude');
  check(
    row?.kind === 'client' && JSON.stringify(row.hosts) === '["mac01"]' && row.scopes.join(',') === 'read,dispatch',
    'listed as a client token: read, dispatch, mac01 only',
    JSON.stringify(row),
  );
  check(!JSON.stringify(listed).includes(clientToken), 'the list never carries the token');

  const { Client: McpClient, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const mcp = new McpClient({ name: 'demo-coding-agent', version: '1.0.0' });
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`${HUB}/mcp`), { requestInit: { headers: { authorization: `Bearer ${clientToken}` } } }),
  );
  const callHub = async (name, args = {}) => {
    const r = await mcp.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    return { isError: r.isError === true, text, data: r.isError ? null : JSON.parse(text) };
  };
  const toolNames = (await mcp.listTools()).tools.map((t) => t.name);
  check(toolNames.includes('dispatch_pocket_task') && !toolNames.includes('update_webhook'), 'its catalog has dispatch and no admin tools');
  const seen = await callHub('list_hosts');
  check(JSON.stringify(seen.data?.hosts?.map((h) => h.id)) === '["mac01"]', 'list_hosts shows only mac01', JSON.stringify(seen.data?.hosts?.map((h) => h.id)));
  const refusedCaps = await callHub('get_host_capabilities', { host: 'dev01' });
  check(refusedCaps.isError && refusedCaps.text.includes('"dev01"'), 'get_host_capabilities on dev01 is refused, naming it', refusedCaps.text);
  const refusedDispatch = await callHub('dispatch_pocket_task', { host: 'dev01', pocketAgentId: 'x', prompt: 'Build the iOS app.' });
  check(refusedDispatch.isError && refusedDispatch.text.includes('"dev01"'), 'dispatch to dev01 is refused, naming it', refusedDispatch.text);

  const pushesBeforeClient = pushReceived.length;
  const started = await callHub('dispatch_pocket_task', { host: 'mac01', pocketAgentId: xcode.body.id, prompt: 'Build the iOS app.' });
  check(!started.isError && started.data?.ref?.startsWith('chat:'), 'the coding agent dispatched to mac01 itself', started.text.slice(0, 120));
  const clientPush = await waitFor(
    () => pushReceived.slice(pushesBeforeClient).find((p) => p.url === `/#/h/mac01/planner/${started.data?.chatId}`),
    30_000,
  );
  check(Boolean(clientPush), 'the target’s approval arrived by push, deep-linked to that chat', clientPush?.url);
  if (clientPush) {
    const tab = await desktopContext.newPage();
    await tab.goto(`${HUB}${clientPush.url}`, { waitUntil: 'domcontentloaded' });
    await tab.waitForSelector('.planner-approval-card', { timeout: 20_000 });
    await tab.click('.planner-approval-card button:has-text("Allow once")');
    await tab.close();
  }
  let clientState = 'still_running';
  for (let i = 0; i < 20 && clientState !== 'complete' && clientState !== 'ended'; i += 1) {
    const waited = await callHub('wait', { host: 'mac01', ref: started.data.ref, timeoutSeconds: 5 });
    clientState = waited.data?.state ?? 'error';
  }
  check(clientState === 'complete', 'the coding agent’s wait sees complete', clientState);
  await sleep(500);
  const createdLine = hubProc.lines.find((l) => /hub mcp client token created/.test(l)) ?? '';
  check(/"label":"laptop claude"/.test(createdLine) && !createdLine.includes(clientToken), 'the Hub logged the mint by label and prefix, never the token');
  check(
    hubProc.lines.some((l) => /hub mcp tool call/.test(l) && /"hubMcpClient":"laptop claude"/.test(l) && /"targetHost":"mac01"/.test(l)),
    'each call is logged with the client token’s label and target host',
  );

  await desktop.click(`${card} .planner-model-row:has-text("laptop claude") button:has-text("Revoke")`);
  await desktop.click('.dialog button:has-text("Revoke")');
  await desktop.waitForSelector(`${card} .planner-model-row:has-text("laptop claude")`, { state: 'detached', timeout: 10_000 });
  const afterRevoke = await callHub('list_hosts').then((r) => (r.isError ? 'refused' : 'answered')).catch(() => 'refused');
  check(afterRevoke === 'refused', 'revoked on the page, its very next call is refused', afterRevoke);
  await mcp.close().catch(() => undefined);

  heading('PA-171 — one Jira webhook on dev01, runs routed to mac01 through the Hub');
  const routed = await hub('/api/hub/webhook-routing/dev01', {
    method: 'PUT',
    body: JSON.stringify({ hubUrl: HUB, allowedHosts: ['mac01'] }),
  });
  const routedRow = routed.body?.hosts?.find((h) => h.hostId === 'dev01');
  check(routed.status === 200 && routedRow?.state === 'routed', 'webhook routing on for dev01 → mac01', JSON.stringify(routedRow));
  const devRouting = (await onBackend(dev01, 'GET', '/api/webhook-routing')).body;
  check(
    devRouting.configured === true && JSON.stringify(devRouting.hosts.map((h) => h.id)) === '["mac01"]',
    'dev01 holds the routing token (prefix only on its API) and may name mac01',
    `${devRouting.tokenPrefix}…`,
  );
  const tokenRow = (await hub('/api/hub/mcp/tokens')).body.tokens.find((t) => t.kind === 'webhook');
  check(
    tokenRow?.scopes?.join(',') === 'dispatch' && JSON.stringify(tokenRow.hosts) === '["mac01"]',
    'the Hub lists it as a webhook token: dispatch only, mac01 only',
    JSON.stringify(tokenRow),
  );

  const devWorkspace = path.join(scratch, 'dev01', 'workspace');
  const macWorkspace = path.join(scratch, 'mac01', 'workspace');
  const signedDelivery = async (slug, secret, issueKey, extra = {}) => {
    const sample = structuredClone(JIRA_SAMPLE_PAYLOAD);
    sample.issue.key = issueKey;
    sample.issue.fields.project.key = issueKey.split('-')[0];
    const body = JSON.stringify({ ...sample, timestamp: Date.now(), ...extra });
    const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
    const res = await fetch(`${dev01.baseUrl}/api/hooks/${slug}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature': signature },
      body,
    });
    return res.status;
  };
  const deliveriesOf = async (id) => (await onBackend(dev01, 'GET', `/api/webhooks/${id}/deliveries?noise=true`)).body.deliveries ?? [];
  const deliveryOf = (id, issueKey, pred = () => true) =>
    waitFor(async () => (await deliveriesOf(id)).find((d) => d.issueKey === issueKey && pred(d)), 45_000, 300);

  // Mixed routing: one URL, two machines.
  const mixed = await onBackend(dev01, 'POST', '/api/webhooks', {
    name: 'Triage',
    slug: 'triage',
    cwd: devWorkspace,
    agent: 'claude',
    overlapPolicy: 'allow',
    skipPermissions: true,
    config: {
      type: 'jira',
      filter: {},
      projectMap: [
        { projectKey: 'PA', cwd: devWorkspace },
        { projectKey: 'XY', cwd: macWorkspace, hostId: 'mac01' },
      ],
    },
  });
  check(mixed.status === 201, 'a Jira webhook on dev01 with PA → dev01 and XY → mac01', mixed.body?.error?.message ?? '');
  const mixedId = mixed.body.webhook.id;
  check((await signedDelivery('triage', mixed.body.secret, 'PA-1')) === 202, 'a signed PA delivery is accepted');
  check((await signedDelivery('triage', mixed.body.secret, 'XY-1')) === 202, 'a signed XY delivery is accepted, at the same URL');
  const paDelivery = await deliveryOf(mixedId, 'PA-1', (d) => d.status !== 'starting');
  check(paDelivery && paDelivery.remoteHostId === null, 'PA ran on dev01 itself', paDelivery?.status);
  const xyDelivery = await deliveryOf(mixedId, 'XY-1', (d) => d.remoteRef !== null || d.status === 'failed');
  check(xyDelivery?.remoteHostId === 'mac01', 'XY was dispatched to mac01', xyDelivery?.remoteRef ?? xyDelivery?.error);
  const macSessions = (await onBackend(mac01, 'GET', '/api/sessions')).body;
  const macList = Array.isArray(macSessions) ? macSessions : (macSessions.sessions ?? []);
  const xySessionId = xyDelivery?.remoteRef?.replace(/^session:/, '');
  check(
    xyDelivery?.remoteRef ? macList.some((s) => s.id === xySessionId && s.cwd === macWorkspace) : /^mac01: /.test(xyDelivery?.error ?? ''),
    'mac01’s own API has that session, in its own folder (or mac01 itself refused it, by name)',
    xySessionId ?? xyDelivery?.error,
  );
  check(xyDelivery?.skipPermissionsEnabled === false, 'the webhook’s Skip permissions did not cross: mac01 decides, and its switch is off');
  const devSessions = (await onBackend(dev01, 'GET', '/api/sessions')).body;
  const devList = Array.isArray(devSessions) ? devSessions : (devSessions.sessions ?? []);
  check(!devList.some((s) => s.cwd === macWorkspace), 'nothing for XY ran on dev01');

  // A Pocket Agent on mac01: approval, push, answered there, settled.
  const pocket = await onBackend(dev01, 'POST', '/api/webhooks', {
    name: 'Remote builds',
    slug: 'remote-builds',
    cwd: '/srv/builds',
    hostId: 'mac01',
    agent: `pocket:${xcode.body.id}`,
    conversationMode: 'per-issue',
    config: { type: 'jira', filter: {} },
  });
  check(pocket.status === 201, 'a webhook whose agent is mac01’s Xcode Pocket Agent', pocket.body?.error?.message ?? '');
  const pocketId = pocket.body.webhook.id;
  const pushesBeforeRemote = pushReceived.length;
  check((await signedDelivery('remote-builds', pocket.body.secret, 'IOS-7')) === 202, 'a signed IOS-7 delivery is accepted');
  const parked = await deliveryOf(pocketId, 'IOS-7', (d) => d.remoteState === 'awaiting_approval');
  check(parked?.status === 'running', 'the delivery stays running while mac01 waits on an approval', parked?.remoteState);
  const remotePush = await waitFor(
    () => pushReceived.slice(pushesBeforeRemote).find((p) => p.url === `/#/h/mac01/planner/${parked?.plannerChatId}`),
    30_000,
  );
  check(Boolean(remotePush), 'the approval arrived by push, deep-linked to the chat on mac01', remotePush?.url);
  // dev01 is the Hub's default host, which the bundle addresses with no host prefix.
  await desktop.goto(`${HUB}/#/hooks/${pocketId}`, { waitUntil: 'domcontentloaded' });
  const remoteRow = await desktop
    .waitForSelector('.history-remote-state:has-text("awaiting approval")', { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  const hostTag = await desktop.textContent('.history-host-tag').catch(() => null);
  check(remoteRow && /mac01/.test(hostTag ?? ''), 'the editor’s delivery row says it is awaiting approval, on mac01', hostTag ?? '');
  await desktop.screenshot({ path: path.join(shots, '7-remote-delivery.png') });
  if (remotePush) {
    const tab = await desktopContext.newPage();
    await tab.goto(`${HUB}${remotePush.url}`, { waitUntil: 'domcontentloaded' });
    await tab.waitForSelector('.planner-approval-card', { timeout: 20_000 });
    await tab.click('.planner-approval-card button:has-text("Allow once")');
    await tab.close();
  }
  const settled = await deliveryOf(pocketId, 'IOS-7', (d) => d.status !== 'running' && d.status !== 'starting');
  check(settled?.status === 'succeeded', 'answered on mac01, the delivery on dev01 settles succeeded', settled?.status);

  check((await signedDelivery('remote-builds', pocket.body.secret, 'IOS-7', { changelog: { items: [{ field: 'status' }] } })) === 202, 'IOS-7’s next delivery is accepted');
  const again = await waitFor(async () => {
    const rows = (await deliveriesOf(pocketId)).filter((d) => d.issueKey === 'IOS-7');
    return rows.length >= 2 && rows[0].remoteRef ? rows[0] : null;
  }, 30_000, 300);
  check(again?.remoteRef === settled?.remoteRef, 'per-issue: it continues the same chat on mac01', again?.remoteRef);

  // Failures: each its own reason, never a local run.
  await hub('/api/hub/webhook-routing/dev01', { method: 'DELETE' });
  check((await signedDelivery('triage', mixed.body.secret, 'XY-2')) === 202, 'with routing switched off, an XY delivery is still answered 2xx');
  const offFailed = await deliveryOf(mixedId, 'XY-2', (d) => d.status === 'failed');
  check(/not set up on this server/.test(offFailed?.error ?? ''), '…and fails naming why, retryable, nothing run on dev01', offFailed?.error);
  check(offFailed?.retryProblem === null, 'that failed delivery can be retried (PA-125)');

  heading('Phone viewport — the Fleet card, and the host sheet’s Fleet entry');
  const phoneContext = await browser.newContext({ ...devices['iPhone 13'] });
  const phone = await phoneContext.newPage();
  await login(phone);
  await phone.goto(`${HUB}/#/hub`, { waitUntil: 'domcontentloaded' });
  await phone.waitForSelector('.fleet-card strong:has-text("Runs on dev01")');
  await phone.click('.host-chip');
  const sheetFleet = await phone.waitForSelector('.sheet-option:has-text("Fleet")', { timeout: 10_000 }).then(() => true).catch(() => false);
  check(sheetFleet, 'the host sheet lists Fleet');
  await phone.screenshot({ path: path.join(shots, '6-phone-sheet.png') });

  heading('PA-171 — with the Hub down, a routed delivery fails with its own reason');
  await hub('/api/hub/webhook-routing/dev01', {
    method: 'PUT',
    body: JSON.stringify({ hubUrl: HUB, allowedHosts: ['mac01'] }),
  });
  process.kill(hubProc.child.pid, 'SIGTERM');
  await sleep(1500);
  const deadHubStatus = await signedDelivery('triage', mixed.body.secret, 'XY-3');
  check(deadHubStatus === 202, 'the delivery is still answered 2xx (Jira does not retry a 5xx)', String(deadHubStatus));
  const downFailed = await deliveryOf(mixedId, 'XY-3', (d) => d.status === 'failed');
  check(/unreachable/i.test(downFailed?.error ?? ''), 'and fails as "Hub unreachable", with no fallback to dev01', downFailed?.error);

  await browser.close();
  llm.close();
  pushService.server.close();
  console.log(`\nScreenshots: ${shots}`);
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
    setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
  });

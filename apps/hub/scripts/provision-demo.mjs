#!/usr/bin/env node
/**
 * PA-70's acceptance criteria, against real processes.
 *
 * Needs no running server and no PA_BASE: like `hub-demo.mjs`, it starts two
 * real backends and a real Hub itself, each with a throwaway data root, and
 * binds them through the actual `hub-bind` handshake. Then it provisions real
 * templates and checks the result *on each backend's own API*, with that
 * backend's own credential — not through the Hub, because "the Hub believes it
 * worked" is exactly what a demo should not accept as evidence.
 *
 * `pnpm build` first. Run with: pnpm demo:provision
 *
 * Why a demo rather than more unit tests: the hub suite provisions against a
 * fake backend, which is right for asserting sequences and for "was this even
 * dialed". What it cannot cover is that the bodies the Hub sends actually
 * satisfy five real Zod schemas on a real build, that a real
 * `POST /api/planner/skills/import` writes a real `SKILL.md`, and that the
 * backend's own audit line really is emitted with the Hub named in it — which
 * is the half of criterion 5 that matters, since it is the record that
 * survives a compromised Hub.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-provision-demo-'));
const children = [];

const token = () => crypto.randomBytes(32).toString('base64url');
const HUB_TOKEN = token();
const HUB_ENC_KEY = crypto.randomBytes(32).toString('base64');
const BACKEND_TOKENS = { dev01: token(), dev02: token(), dev03: token() };
const BACKEND_ENC_KEYS = {
  dev01: crypto.randomBytes(32).toString('base64'),
  dev02: crypto.randomBytes(32).toString('base64'),
};

/** Every stdout line each backend wrote, so the audit trail can be read. */
const backendLogs = { dev01: [], dev02: [], dev03: [] };

function cleanup() {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.on('exit', cleanup);

async function waitForHealth(baseUrl, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  bad(`${label} never became healthy`);
  return false;
}

function startBackend(id, port) {
  const dataDir = path.join(scratch, id, 'data');
  const workspace = path.join(scratch, id, 'workspace');
  const home = path.join(scratch, id, 'home');
  for (const dir of [dataDir, workspace, home]) fs.mkdirSync(dir, { recursive: true });

  const child = spawn(process.execPath, ['apps/server/dist/server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      HOST: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'development',
      // `warn` deliberately, and it is an assertion in itself:
      // `auditConfigChange` logs a *Hub's* change at `warn` and an operator's
      // own at `info`, so a backend running at this level should still show
      // every provisioning action and none of the local noise. Step 7 reads
      // these lines back.
      LOG_LEVEL: 'warn',
      POCKETAGENT_AUTH_TOKEN: BACKEND_TOKENS[id],
      POCKETAGENT_WORKSPACE_ROOTS: workspace,
      POCKETAGENT_DATA_DIR: dataDir,
      POCKETAGENT_BACKEND: 'direct',
      POCKETAGENT_COOKIE_SECURE: 'false',
      POCKETAGENT_ADOPT_TMUX_SOCKET: '',
      // Needed for the provider and MCP kinds: without it a backend disables
      // encrypted-secret features entirely (PA-28's "unset disables the
      // feature rather than failing the boot"). A host missing it is a real
      // operator situation, and step 4 below demonstrates what it looks like
      // before the key is in play here.
      ...(id === 'dev03' ? {} : { POCKETAGENT_SETTINGS_ENC_KEY: BACKEND_ENC_KEYS[id] }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Captured rather than ignored, unlike `hub-demo.mjs`: the backend's own
  // audit line is a deliverable of this ticket, so reading it is the point.
  child.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim().length > 0) backendLogs[id].push(line);
    }
  });
  child.stderr.on('data', (chunk) => {
    const text = String(chunk);
    if (/error|fatal/i.test(text)) process.stderr.write(`[${id}] ${text}`);
  });
  children.push(child);
  return { id, port, baseUrl: `http://127.0.0.1:${port}`, dataDir, workspace, child };
}

function startHub(port) {
  const dataDir = path.join(scratch, 'hub');
  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, ['apps/hub/dist/server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      LOG_LEVEL: 'warn',
      POCKETAGENT_HUB_HOST: '127.0.0.1',
      POCKETAGENT_HUB_PORT: String(port),
      POCKETAGENT_HUB_AUTH_TOKEN: HUB_TOKEN,
      POCKETAGENT_HUB_DATA_DIR: dataDir,
      POCKETAGENT_SETTINGS_ENC_KEY: HUB_ENC_KEY,
      POCKETAGENT_COOKIE_SECURE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const hubLines = [];
  child.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim().length > 0) hubLines.push(line);
    }
  });
  child.stderr.on('data', (chunk) => {
    const text = String(chunk);
    if (/error|fatal/i.test(text)) process.stderr.write(`[hub] ${text}`);
  });
  children.push(child);
  return { baseUrl: `http://127.0.0.1:${port}`, child, lines: hubLines };
}

let hubCookie = '';
let hubBase = '';

async function hub(urlPath, init = {}) {
  const response = await fetch(hubBase + urlPath, {
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

/** A read straight to a backend, with that backend's own master credential. */
async function onBackend(backend, urlPath) {
  const login = await fetch(`${backend.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: BACKEND_TOKENS[backend.id] }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const response = await fetch(`${backend.baseUrl}${urlPath}`, { headers: { cookie } });
  return response.json();
}

async function main() {
  console.log('PA-70 — hub templates and provisioning, against real processes');
  console.log(`scratch: ${scratch}`);

  heading('Start two backends and a Hub');
  const dev01 = startBackend('dev01', 8931);
  const dev02 = startBackend('dev02', 8932);
  const hubProc = startHub(8933);
  hubBase = hubProc.baseUrl;
  const up = await Promise.all([
    waitForHealth(dev01.baseUrl, 'dev01'),
    waitForHealth(dev02.baseUrl, 'dev02'),
    waitForHealth(hubBase, 'hub'),
  ]);
  if (up.some((v) => !v)) throw new Error('a process never came up');
  ok('three processes healthy');

  heading('Log in to the Hub and bind both backends');
  await hub('/api/auth/login', { method: 'POST', body: JSON.stringify({ token: HUB_TOKEN }) });
  for (const backend of [dev01, dev02]) {
    await hub('/api/hub/hosts', {
      method: 'POST',
      body: JSON.stringify({ id: backend.id, label: backend.id, baseUrl: backend.baseUrl }),
    });
    const bound = await hub(`/api/hub/hosts/${backend.id}/bind`, {
      method: 'POST',
      body: JSON.stringify({ token: BACKEND_TOKENS[backend.id], label: 'provisioning demo' }),
    });
    check(bound.status === 200, `${backend.id} bound`, bound.body?.error?.message ?? '');
  }

  heading('Criterion 1 — one Pocket Agent template, two hosts, separate secrets');
  const agentTemplate = await hub('/api/hub/templates', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'pocket-agent',
      name: 'Release Notes',
      description: 'Writes release notes.',
      payload: {
        name: 'Release Notes',
        defaultModelId: null,
        identityPrompt: 'You write release notes.',
        memoryEnabled: true,
        mcpEnabled: true,
        disabledTools: ['exec_command'],
      },
    }),
  });
  check(agentTemplate.status === 201, 'template created', agentTemplate.body?.error?.message ?? '');
  const agentId = agentTemplate.body?.template?.id;

  const run = await hub(`/api/hub/templates/${agentId}/instantiate`, {
    method: 'POST',
    body: JSON.stringify({ hostIds: ['dev01', 'dev02'] }),
  });
  check(
    run.body?.results?.every((r) => r.outcome === 'provisioned'),
    'provisioned on both hosts',
    JSON.stringify(run.body?.results?.map((r) => `${r.hostId}:${r.outcome}`)),
  );

  for (const backend of [dev01, dev02]) {
    const list = await onBackend(backend, '/api/planner/workspaces');
    const agent = list.workspaces?.find((w) => w.name === 'Release Notes');
    check(!!agent, `${backend.id} has the agent`, agent?.id ?? 'missing');
    // Each host minted its own directory under its own data root. A template
    // carries no path, which is what makes it portable at all.
    check(
      !!agent && agent.path.startsWith(backend.dataDir),
      `${backend.id}'s agent lives under its own data root`,
      agent?.path ?? '',
    );
    check(
      !!agent && agent.identityPrompt === 'You write release notes.',
      `${backend.id}'s agent got the full configuration`,
    );
    const tools = await onBackend(backend, `/api/planner/workspaces/${agent.id}/tools`);
    const execTool = tools.tools?.find((t) => t.name === 'exec_command');
    check(!!execTool && execTool.enabled === false, `${backend.id} has exec_command disabled`);
  }

  heading('A provider template, with a different key per host');
  const providerTemplate = await hub('/api/hub/templates', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'claude-provider',
      name: 'House gateway',
      payload: {
        name: 'House gateway',
        providerKind: 'claude-compatible',
        baseUrl: 'https://gateway.invalid/anthropic',
        models: ['house-sonnet'],
        defaultModel: 'house-sonnet',
        smallModel: null,
        allowUnattended: false,
      },
    }),
  });
  const providerId = providerTemplate.body?.template?.id;
  const holes = providerTemplate.body?.template?.secretHoles ?? [];
  check(
    holes.length === 1 && holes[0].key === 'apiKey' && holes[0].required,
    'the template declares one required secret-shaped hole',
  );

  for (const [hostId, key] of [
    ['dev01', 'key-for-dev01'],
    ['dev02', 'key-for-dev02'],
  ]) {
    const provisioned = await hub(`/api/hub/templates/${providerId}/instantiate`, {
      method: 'POST',
      body: JSON.stringify({ hostIds: [hostId], secrets: { apiKey: key } }),
    });
    check(
      provisioned.body?.results?.[0]?.outcome === 'provisioned',
      `provider provisioned on ${hostId}`,
      provisioned.body?.results?.[0]?.message ?? '',
    );
  }
  for (const backend of [dev01, dev02]) {
    const list = await onBackend(backend, '/api/custom-claude-providers');
    const provider = list.providers?.find((p) => p.name === 'House gateway');
    check(!!provider, `${backend.id} has the provider`);
    // The key is never returned by any route, on either side — so what this
    // can check is that the provider works without it being readable.
    check(
      !!provider && !JSON.stringify(provider).includes('key-for-'),
      `${backend.id} does not hand the key back`,
    );
  }

  heading('A host missing POCKETAGENT_SETTINGS_ENC_KEY reports the backend\'s own reason');
  // Worth demonstrating rather than only unit-testing: this is the most likely
  // real provisioning failure on a freshly-installed host, and the thing that
  // makes it diagnosable is that the *backend's* sentence reaches the operator
  // unchanged instead of becoming a generic "provisioning failed".
  const dev03 = startBackend('dev03', 8934);
  if (await waitForHealth(dev03.baseUrl, 'dev03')) {
    await hub('/api/hub/hosts', {
      method: 'POST',
      body: JSON.stringify({ id: 'dev03', label: 'dev03', baseUrl: dev03.baseUrl }),
    });
    await hub('/api/hub/hosts/dev03/bind', {
      method: 'POST',
      body: JSON.stringify({ token: BACKEND_TOKENS.dev03, label: 'provisioning demo' }),
    });
    const unkeyed = await hub(`/api/hub/templates/${providerId}/instantiate`, {
      method: 'POST',
      body: JSON.stringify({ hostIds: ['dev03'], secrets: { apiKey: 'key-for-dev03' } }),
    });
    const result = unkeyed.body?.results?.[0];
    check(result?.outcome === 'failed', 'the run fails rather than half-succeeding');
    check(
      (result?.message ?? '').includes('POCKETAGENT_SETTINGS_ENC_KEY'),
      "and names the backend's own reason verbatim",
      result?.message ?? '',
    );
  }

  heading('Criterion 4 — no secret value is stored in a template');
  const hubDb = path.join(scratch, 'hub', 'pocketagent-hub.db');
  const raw = fs.readFileSync(hubDb);
  for (const key of ['key-for-dev01', 'key-for-dev02']) {
    check(!raw.includes(Buffer.from(key)), `${key} appears nowhere in the Hub database`);
  }
  const templateList = await hub('/api/hub/templates');
  check(
    !JSON.stringify(templateList.body).includes('key-for-'),
    'no secret comes back from the template API',
  );

  heading('Criterion 5 — the change is logged on the backend, naming the Hub');
  const auditLine = backendLogs.dev01.find(
    (line) => line.includes('pocket agent created') && line.includes('hub:provisioning demo'),
  );
  check(!!auditLine, "dev01's own log names the Hub that created the agent");
  const providerLine = backendLogs.dev02.find(
    (line) => line.includes('custom claude provider created') && line.includes('"by":"hub:'),
  );
  check(!!providerLine, "dev02's own log attributes the provider to a hub credential");
  check(
    !backendLogs.dev01.some((line) => line.includes('key-for-dev01')),
    'no audit line contains the credential it carried',
  );

  heading('Criterion 2 — editing the template changes nothing on either host');
  const before = {};
  for (const backend of [dev01, dev02]) {
    const list = await onBackend(backend, '/api/planner/workspaces');
    before[backend.id] = list.workspaces.find((w) => w.name === 'Release Notes');
  }
  await hub(`/api/hub/templates/${agentId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      payload: {
        name: 'Release Notes',
        defaultModelId: null,
        identityPrompt: 'Rewritten persona.',
        memoryEnabled: false,
        mcpEnabled: true,
        disabledTools: [],
      },
    }),
  });
  await sleep(200);
  for (const backend of [dev01, dev02]) {
    const list = await onBackend(backend, '/api/planner/workspaces');
    const now = list.workspaces.find((w) => w.name === 'Release Notes');
    check(
      JSON.stringify(now) === JSON.stringify(before[backend.id]),
      `${backend.id} is untouched by the edit`,
    );
  }
  const stale = (await hub('/api/hub/templates')).body.templates.find((t) => t.id === agentId);
  check(
    stale.revision === 2 && stale.provisionings.every((p) => p.stale === true),
    'both hosts now read as stale, which is the whole obligation of the no-sync model',
  );

  heading('Criterion 3 — re-provisioning is an explicit, confirmed overwrite');
  const unconfirmed = await hub(`/api/hub/templates/${agentId}/instantiate`, {
    method: 'POST',
    body: JSON.stringify({ hostIds: ['dev01'] }),
  });
  check(
    unconfirmed.body?.results?.[0]?.outcome === 'skipped',
    'an unconfirmed re-run is skipped',
    unconfirmed.body?.results?.[0]?.message ?? '',
  );
  const afterSkip = (await onBackend(dev01, '/api/planner/workspaces')).workspaces.find(
    (w) => w.name === 'Release Notes',
  );
  check(
    JSON.stringify(afterSkip) === JSON.stringify(before.dev01),
    'and wrote nothing',
  );

  const confirmed = await hub(`/api/hub/templates/${agentId}/instantiate`, {
    method: 'POST',
    body: JSON.stringify({ hostIds: ['dev01'], overwrite: true }),
  });
  check(
    confirmed.body?.results?.[0]?.outcome === 'overwritten',
    'a confirmed re-run overwrites in place',
  );
  const dev01Agents = (await onBackend(dev01, '/api/planner/workspaces')).workspaces.filter(
    (w) => w.name === 'Release Notes',
  );
  check(dev01Agents.length === 1, 'no duplicate agent was created', `${dev01Agents.length} found`);
  check(
    dev01Agents[0]?.identityPrompt === 'Rewritten persona.' &&
      dev01Agents[0]?.memoryEnabled === false,
    'and the new configuration landed',
  );
  const dev02Agents = (await onBackend(dev02, '/api/planner/workspaces')).workspaces.filter(
    (w) => w.name === 'Release Notes',
  );
  check(
    dev02Agents[0]?.identityPrompt === 'You write release notes.',
    'dev02, which was not re-provisioned, still has the old configuration',
  );

  heading('A skill template writes a real SKILL.md, and a collision is refused');
  const skillTemplate = await hub('/api/hub/templates', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'skill',
      name: 'Release notes skill',
      payload: {
        slug: 'release-notes',
        name: 'Release notes',
        description: 'How release notes are written here.',
        body: 'Read the changelog, then summarise per component.',
      },
    }),
  });
  const skillId = skillTemplate.body?.template?.id;
  const skillRun = await hub(`/api/hub/templates/${skillId}/instantiate`, {
    method: 'POST',
    body: JSON.stringify({ hostIds: ['dev01', 'dev02'] }),
  });
  check(
    skillRun.body?.results?.every((r) => r.outcome === 'provisioned'),
    'skill provisioned on both hosts',
  );
  const onDisk = path.join(dev01.dataDir, 'planner-skills', 'release-notes', 'SKILL.md');
  check(fs.existsSync(onDisk), 'dev01 has a real SKILL.md on disk', onDisk);
  check(
    fs.existsSync(onDisk) &&
      fs.readFileSync(onDisk, 'utf8').includes('summarise per component'),
    'with the template body in it',
  );

  // A skill somebody wrote by hand on dev02, at a slug a *second* template
  // also wants. The Hub did not create it, so no overwrite flag may replace it.
  const handWritten = path.join(dev02.dataDir, 'planner-skills', 'hand-written');
  fs.mkdirSync(handWritten, { recursive: true });
  fs.writeFileSync(
    path.join(handWritten, 'SKILL.md'),
    '---\nname: Hand written\ndescription: mine\n---\nDo not clobber me.\n',
  );
  await fetch(`${dev02.baseUrl}/api/planner/skills/refresh`, {
    method: 'POST',
    headers: {
      cookie: (
        await (
          await fetch(`${dev02.baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: BACKEND_TOKENS.dev02 }),
          })
        ).headers.get('set-cookie') ?? ''
      ).split(';')[0],
    },
  });
  const clashTemplate = await hub('/api/hub/templates', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'skill',
      name: 'Clashing skill',
      payload: {
        slug: 'hand-written',
        name: 'Hand written',
        description: 'From the Hub.',
        body: 'Replaced by the Hub.',
      },
    }),
  });
  const clash = await hub(`/api/hub/templates/${clashTemplate.body.template.id}/instantiate`, {
    method: 'POST',
    body: JSON.stringify({ hostIds: ['dev02'], overwrite: true }),
  });
  check(
    clash.body?.results?.[0]?.outcome === 'conflict',
    'a slug this Hub did not provision is a conflict, even with overwrite',
    clash.body?.results?.[0]?.message ?? '',
  );
  check(
    fs.readFileSync(path.join(handWritten, 'SKILL.md'), 'utf8').includes('Do not clobber me'),
    "and the human's skill is untouched",
  );

  heading('A host that is down fails alone');
  dev02.child.kill('SIGKILL');
  await sleep(500);
  const mixed = await hub(`/api/hub/templates/${agentId}/instantiate`, {
    method: 'POST',
    body: JSON.stringify({ hostIds: ['dev02', 'dev01'], overwrite: true }),
  });
  const byHost = Object.fromEntries(
    (mixed.body?.results ?? []).map((r) => [r.hostId, r.outcome]),
  );
  check(byHost.dev02 === 'failed', 'the dead host fails', mixed.body?.results?.[0]?.message ?? '');
  check(byHost.dev01 === 'overwritten', 'and the live one still succeeds');

  console.log(
    failures === 0
      ? '\n✅ all PA-70 acceptance criteria demonstrated\n'
      : `\n❌ ${failures} check(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

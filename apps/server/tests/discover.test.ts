import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { browseDirectory, discoverFolders } from '../src/discover/index.js';
import { createTestApp, type TestApp } from './helpers.js';

describe('discoverFolders', () => {
  let home: string;
  let claude: string;
  let codex: string;
  let work: string;

  const writeClaude = (name: string, cwd: string): void => {
    fs.mkdirSync(path.join(claude, name), { recursive: true });
    fs.writeFileSync(
      path.join(claude, name, 'a.jsonl'),
      JSON.stringify({ type: 'user', sessionId: name, cwd, message: { content: 'hi' } }),
    );
  };

  /** Codex nests by date and puts the cwd inside a `session_meta` payload. */
  const writeCodex = (day: string, cwd: string): void => {
    const dir = path.join(codex, '2026', '08', day);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `rollout-${day}.jsonl`),
      [
        JSON.stringify({ type: 'session_meta', payload: { session_id: day, cwd } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      ].join('\n'),
    );
  };

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync('/tmp/pa-disc-'));
    claude = path.join(home, 'claude');
    codex = path.join(home, 'codex');
    work = path.join(home, 'work');
    fs.mkdirSync(work);
    fs.mkdirSync(claude);
    fs.mkdirSync(codex);
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const run = () =>
    discoverFolders({ claudeProjectsDir: claude, codexSessionsDir: codex });

  it('finds a directory from a Claude transcript', async () => {
    writeClaude('one', work);
    const found = await run();
    expect(found.map((f) => f.path)).toEqual([work]);
    expect(found[0]?.agents).toEqual(['claude']);
  });

  it('finds a directory from a Codex rollout, nested by date', async () => {
    writeCodex('07', work);
    const found = await run();
    expect(found.map((f) => f.path)).toEqual([work]);
    expect(found[0]?.agents).toEqual(['codex']);
  });

  it('merges a directory both agents have used', async () => {
    writeClaude('one', work);
    writeCodex('07', work);
    const found = await run();
    expect(found).toHaveLength(1);
    expect(found[0]?.agents.sort()).toEqual(['claude', 'codex']);
    expect(found[0]?.sessions).toBe(2);
  });

  it('drops a directory that has since been deleted', async () => {
    const gone = path.join(home, 'gone');
    fs.mkdirSync(gone);
    writeClaude('one', gone);
    fs.rmSync(gone, { recursive: true });
    expect(await run()).toEqual([]);
  });

  it('ignores a transcript with no working directory in it', async () => {
    fs.mkdirSync(path.join(claude, 'empty'));
    fs.writeFileSync(path.join(claude, 'empty', 'a.jsonl'), JSON.stringify({ type: 'summary' }));
    expect(await run()).toEqual([]);
  });

  it('survives rubbish without failing the whole scan', async () => {
    fs.mkdirSync(path.join(claude, 'bad'));
    fs.writeFileSync(path.join(claude, 'bad', 'a.jsonl'), 'not json\n{oops\n');
    writeClaude('good', work);
    expect((await run()).map((f) => f.path)).toEqual([work]);
  });

  it('returns nothing when neither agent has any history', async () => {
    expect(
      await discoverFolders({
        claudeProjectsDir: '/tmp/nope-claude',
        codexSessionsDir: '/tmp/nope-codex',
      }),
    ).toEqual([]);
  });
});

describe('browseDirectory', () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync('/tmp/pa-browse-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('lists subdirectories, and only directories', async () => {
    fs.mkdirSync(path.join(root, 'alpha'));
    fs.mkdirSync(path.join(root, 'beta'));
    fs.writeFileSync(path.join(root, 'a-file'), 'x');
    expect((await browseDirectory(root)).map((e) => e.name)).toEqual(['alpha', 'beta']);
  });

  it('leaves out dotfiles and build output, which bury what you are looking for', async () => {
    for (const name of ['.git', 'node_modules', '__pycache__', 'venv', 'dist', 'real']) {
      fs.mkdirSync(path.join(root, name));
    }
    expect((await browseDirectory(root)).map((e) => e.name)).toEqual(['real']);
  });

  it('flags git repositories, which is usually what you are after', async () => {
    fs.mkdirSync(path.join(root, 'repo', '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'plain'));
    const entries = await browseDirectory(root);
    expect(entries.find((e) => e.name === 'repo')?.isGitRepo).toBe(true);
    expect(entries.find((e) => e.name === 'plain')?.isGitRepo).toBe(false);
  });

  it('resolves symlinks to where they point', async () => {
    const target = path.join(root, 'target');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(root, 'link'));
    const entries = await browseDirectory(root);
    expect(entries.find((e) => e.name === 'link')?.path).toBe(target);
  });

  it('skips a dangling symlink instead of listing a path that is not there', async () => {
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'dangling'));
    expect(await browseDirectory(root)).toEqual([]);
  });
});

describe('managing folders over HTTP', () => {
  let t: TestApp;
  let scratch: string;

  beforeEach(async () => {
    t = await createTestApp();
    scratch = fs.realpathSync(fs.mkdtempSync('/tmp/pa-http-ws-'));
  });
  afterEach(async () => {
    await t.cleanup();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const headers = () => ({ cookie: t.cookie });
  const paths = async (): Promise<string[]> => {
    const res = await t.app.inject({ method: 'GET', url: '/api/workspaces', headers: headers() });
    return res.json().workspaces.map((w: { path: string }) => w.path);
  };

  it('adds a folder outside every configured root — that is the point', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/workspaces/add',
      headers: headers(),
      payload: { path: scratch },
    });
    expect(res.statusCode).toBe(200);
    expect(await paths()).toContain(scratch);
  });

  it('lets a session run in a folder once it is added, and not before', async () => {
    const create = () =>
      t.app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: headers(),
        payload: { agent: 'shell', cwd: scratch, cols: 80, rows: 24 },
      });

    expect((await create()).statusCode).toBe(403);

    await t.app.inject({
      method: 'POST',
      url: '/api/workspaces/add',
      headers: headers(),
      payload: { path: scratch },
    });
    const after = await create();
    expect(after.statusCode).toBe(201);
    await t.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${after.json().id}`,
      headers: headers(),
    });
  });

  it('refuses "/" and a path that is not a directory', async () => {
    const slash = await t.app.inject({
      method: 'POST',
      url: '/api/workspaces/add',
      headers: headers(),
      payload: { path: '/' },
    });
    expect(slash.statusCode).toBe(403);

    const file = path.join(scratch, 'f');
    fs.writeFileSync(file, 'x');
    const notDir = await t.app.inject({
      method: 'POST',
      url: '/api/workspaces/add',
      headers: headers(),
      payload: { path: file },
    });
    expect(notDir.statusCode).toBe(400);
  });

  it('removing a folder revokes it as a working directory', async () => {
    await t.app.inject({
      method: 'POST',
      url: '/api/workspaces/add',
      headers: headers(),
      payload: { path: scratch },
    });
    await t.app.inject({
      method: 'POST',
      url: '/api/workspaces/remove',
      headers: headers(),
      payload: { path: scratch },
    });
    expect(await paths()).not.toContain(scratch);

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(),
      payload: { agent: 'shell', cwd: scratch, cols: 80, rows: 24 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('browses a directory and reports where it can go next', async () => {
    fs.mkdirSync(path.join(scratch, 'child'));
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/browse?path=${encodeURIComponent(scratch)}`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.path).toBe(scratch);
    expect(body.parent).toBe(path.dirname(scratch));
    expect(body.entries.map((e: { name: string }) => e.name)).toEqual(['child']);
    expect(body.added).toBe(false);
  });

  it('marks directories that are already projects', async () => {
    const child = path.join(scratch, 'child');
    fs.mkdirSync(child);
    await t.app.inject({
      method: 'POST',
      url: '/api/workspaces/add',
      headers: headers(),
      payload: { path: child },
    });
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/browse?path=${encodeURIComponent(scratch)}`,
      headers: headers(),
    });
    expect(res.json().entries[0].added).toBe(true);
  });

  it('404s a directory that is not there', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/browse?path=/tmp/definitely-not-here-xyz',
      headers: headers(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires authentication for all of it', async () => {
    for (const [method, url] of [
      ['GET', '/api/browse'],
      ['GET', '/api/discovered'],
      ['POST', '/api/workspaces/add'],
      ['POST', '/api/workspaces/remove'],
    ] as const) {
      const res = await t.app.inject({ method, url, payload: { path: '/tmp' } });
      expect(res.statusCode, url).toBe(401);
    }
  });
});

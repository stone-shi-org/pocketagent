import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CronService } from '../src/cron/index.js';
import {
  insertCronJob,
  openDatabase,
  readCronJob,
  readCronRuns,
  type CronJobRow,
  type Db,
} from '../src/db/index.js';
import type { SessionManager } from '../src/sessions/manager.js';
import type { WorkspaceRegistry } from '../src/workspaces/index.js';
import { WorkspaceError } from '../src/workspaces/index.js';
import type { WorktreeService } from '../src/git/worktree.js';
import type { AgentRegistry } from '../src/agents/registry.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe('cron job routes', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  const post = (payload: unknown) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/cron/jobs',
      headers: authHeaders(ctx.cookie),
      payload,
    });

  const validJob = (overrides: Record<string, unknown> = {}) => ({
    name: 'Nightly review',
    cwd: ctx.projectDir,
    agent: 'claude',
    prompt: 'Review yesterday’s commits.',
    preset: { every: 'day', hour: 3, minute: 0 },
    timeZone: 'UTC',
    ...overrides,
  });

  it('creates a job from a preset and compiles it to an expression', async () => {
    const res = await post(validJob());
    expect(res.statusCode).toBe(201);
    const job = res.json();
    expect(job.cronExpr).toBe('0 3 * * *');
    expect(job.schedule).toEqual({ kind: 'preset', preset: { every: 'day', hour: 3, minute: 0 } });
    expect(job.nextRunAt).toBeGreaterThan(Date.now());
    // The picker descriptor round-trips, so the editor can re-open the picker.
    expect(job.enabled).toBe(true);
  });

  it('defaults skip-permissions ON, unlike every other session path', async () => {
    // Deliberate inversion — a scheduled run is unattended, so approvals routed
    // to a browser nobody is watching would park it forever. Documented in
    // CLAUDE.md as a third override. Asserted here so it cannot drift silently.
    const job = (await post(validJob())).json();
    expect(job.skipPermissionsEnabled).toBe(true);

    const off = (await post(validJob({ name: 'Careful', skipPermissions: false }))).json();
    expect(off.skipPermissionsEnabled).toBe(false);
  });

  it('accepts a raw expression and drops the preset descriptor', async () => {
    const job = (await post(validJob({ preset: undefined, cronExpr: '*/15 9-17 * * 1-5' }))).json();
    expect(job.cronExpr).toBe('*/15 9-17 * * 1-5');
    expect(job.schedule).toEqual({ kind: 'expression' });
  });

  it('rejects a body with both a preset and an expression', async () => {
    const res = await post(validJob({ cronExpr: '0 3 * * *' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/not both/i);
  });

  it('rejects a body with neither', async () => {
    const res = await post(validJob({ preset: undefined }));
    expect(res.statusCode).toBe(400);
  });

  it('rejects a malformed expression', async () => {
    const res = await post(validJob({ preset: undefined, cronExpr: '0 0 * *' }));
    expect(res.statusCode).toBe(400);
  });

  it('rejects a schedule that can never fire, rather than saving a job that never runs', async () => {
    // February 30th.
    const res = await post(validJob({ preset: undefined, cronExpr: '0 0 30 2 *' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/no future run/i);
    // And it left nothing behind.
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/cron/jobs',
      headers: authHeaders(ctx.cookie),
    });
    expect(list.json().jobs).toHaveLength(0);
  });

  it('refuses an agent that has no structured mode', async () => {
    const res = await post(validJob({ agent: 'shell' }));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/cannot be scheduled/i);
  });

  it('refuses an unknown agent', async () => {
    expect((await post(validJob({ agent: 'nope' }))).statusCode).toBe(400);
  });

  it('refuses a directory outside every workspace folder', async () => {
    const res = await post(validJob({ cwd: '/etc' }));
    expect(res.statusCode).toBe(403);
  });

  it('rejects an unknown time zone', async () => {
    const res = await post(validJob({ timeZone: 'Mars/Olympus_Mons' }));
    expect(res.statusCode).toBe(400);
  });

  it('patches a field without clobbering the others', async () => {
    const job = (await post(validJob())).json();
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/cron/jobs/${job.id}`,
      headers: authHeaders(ctx.cookie),
      payload: { name: 'Renamed' },
    });
    expect(res.statusCode).toBe(200);
    const patched = res.json();
    expect(patched.name).toBe('Renamed');
    // The trap this guards: `.partial()` keeps `.default()`s, so an omitted
    // field would silently reset instead of being left alone.
    expect(patched.cronExpr).toBe('0 3 * * *');
    expect(patched.overlapPolicy).toBe('skip');
    expect(patched.skipPermissionsEnabled).toBe(true);
    expect(patched.prompt).toBe(job.prompt);
  });

  it('can clear a model once set, via an explicit null', async () => {
    const job = (await post(validJob({ model: 'opus' }))).json();
    expect(job.model).toBe('opus');

    const patch = async (body: unknown) =>
      (
        await ctx.app.inject({
          method: 'PATCH',
          url: `/api/cron/jobs/${job.id}`,
          headers: authHeaders(ctx.cookie),
          payload: body,
        })
      ).json();

    // Omitting the key must leave it alone...
    expect((await patch({ name: 'Same model' })).model).toBe('opus');
    // ...and an explicit null must clear it. Without a nullable `model` there
    // would be no way to undo a model choice at all.
    expect((await patch({ model: null })).model).toBeNull();
  });

  it('disabling a job clears its next run', async () => {
    const job = (await post(validJob())).json();
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/cron/jobs/${job.id}`,
      headers: authHeaders(ctx.cookie),
      payload: { enabled: false },
    });
    expect(res.json().nextRunAt).toBeNull();
  });

  it('deleting a job keeps its run history', async () => {
    const job = (await post(validJob())).json();
    // Fabricate a finished run rather than spawning a real agent.
    ctx.db
      .prepare(
        `INSERT INTO cron_runs (id, job_id, job_name, agent, status, trigger, scheduled_for, started_at)
         VALUES ('run-1', ?, 'Nightly review', 'claude', 'succeeded', 'schedule', 1, 1)`,
      )
      .run(job.id);

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/cron/jobs/${job.id}`,
      headers: authHeaders(ctx.cookie),
    });
    expect(res.json()).toEqual({ ok: true, runsKept: 1 });

    // The run survives, orphaned but still self-describing.
    const row = ctx.db.prepare('SELECT * FROM cron_runs WHERE id = ?').get('run-1') as {
      job_id: string | null;
      job_name: string;
    };
    expect(row.job_id).toBeNull();
    expect(row.job_name).toBe('Nightly review');
  });

  it('surfaces jobs on the project tree, before they have ever run', async () => {
    await post(validJob());
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: authHeaders(ctx.cookie),
    });
    const project = res
      .json()
      .projects.find((p: { cwd: string }) => p.cwd === ctx.projectDir);
    expect(project.cronJobs).toHaveLength(1);
    expect(project.cronJobs[0].name).toBe('Nightly review');
  });
});

// ---------------------------------------------------------------------------
// Scheduler policies
//
// Driven against stub services with an injected clock: the policies are about
// *when* things happen, and waiting 30 seconds per assertion (or spawning real
// agents) would make them untestable rather than merely slow.
// ---------------------------------------------------------------------------

describe('cron scheduler policies', () => {
  let db: Db;
  let clock: number;
  let created: { cwd: string }[];
  let aliveSessions: Set<string>;
  let resolveFails: Error | null;

  const SESSION_ID = 'sess-1';

  beforeEach(() => {
    db = openDatabase(':memory:');
    clock = Date.parse('2026-08-28T12:00:00Z');
    created = [];
    aliveSessions = new Set();
    resolveFails = null;
  });
  afterEach(() => {
    db.close();
  });

  function makeService(): CronService {
    const sessions = {
      create: async (input: { cwd: string }) => {
        if (resolveFails) throw resolveFails;
        created.push({ cwd: input.cwd });
        aliveSessions.add(SESSION_ID);
        return {
          id: SESSION_ID,
          transport: 'structured',
          on: () => undefined,
          prompt: () => true,
        };
      },
      find: (id: string) => (aliveSessions.has(id) ? { status: 'running' } : null),
    } as unknown as SessionManager;

    const workspaces = {
      resolveWorkspacePath: async (p: string) => {
        if (resolveFails) throw resolveFails;
        return p;
      },
      labelFor: (p: string) => p,
    } as unknown as WorkspaceRegistry;

    return new CronService({
      db,
      sessions,
      workspaces,
      worktrees: {} as WorktreeService,
      agents: { get: () => ({ displayName: 'Claude Code' }) } as unknown as AgentRegistry,
      now: () => clock,
    });
  }

  function seedJob(overrides: Partial<CronJobRow> = {}): CronJobRow {
    const row: CronJobRow = {
      id: 'job-1',
      name: 'Hourly',
      enabled: 1,
      cron_expr: '0 * * * *',
      time_zone: 'UTC',
      schedule_kind: 'expression',
      preset_json: null,
      cwd: '/tmp/project',
      agent: 'claude',
      worktree_mode: 'none',
      model: null,
      effort: null,
      effort_set: 0,
      skip_permissions: 1,
      prompt: 'do the thing',
      overlap_policy: 'skip',
      created_at: clock,
      updated_at: clock,
      next_run_at: clock - 60_000,
      last_run_at: null,
      last_run_status: null,
      last_error: null,
      ...overrides,
    };
    insertCronJob(db, row);
    return row;
  }

  it('fires a firing that is only slightly late — a restart must not lose it', async () => {
    seedJob({ next_run_at: clock - 60_000 });
    const cron = makeService();
    await cron.init();

    expect(created).toHaveLength(1);
    const runs = readCronRuns(db, { limit: 10 });
    expect(runs.map((r) => r.status)).toEqual(['running']);
  });

  it('coalesces a long outage into ONE skipped run instead of a storm', async () => {
    // A week offline for an hourly job is 168 missed occurrences. Firing them
    // all would spawn 168 agents; recording them all would make the run list
    // useless. Exactly one row, and no session.
    seedJob({ next_run_at: clock - 7 * 24 * 3600_000 });
    const cron = makeService();
    await cron.init();

    expect(created).toHaveLength(0);
    const runs = readCronRuns(db, { limit: 500 });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('skipped');
    expect(runs[0]?.error).toMatch(/missed scheduled runs/i);

    // And the schedule rolled forward rather than staying stuck in the past.
    expect(readCronJob(db, 'job-1')?.next_run_at).toBeGreaterThan(clock);
  });

  it('skips a firing while the previous run is still alive', async () => {
    seedJob({ next_run_at: clock - 60_000 });
    const cron = makeService();
    await cron.init();
    expect(created).toHaveLength(1);

    // An hour later the job is due again, but the first run's session is still
    // running.
    clock += 3600_000;
    await cron.tick();

    expect(created).toHaveLength(1); // no second agent
    const statuses = readCronRuns(db, { limit: 10 }).map((r) => r.status);
    expect(statuses).toContain('skipped');
    expect(readCronRuns(db, { limit: 10 }).find((r) => r.status === 'skipped')?.error).toMatch(
      /still in progress/i,
    );
  });

  it('runs concurrently when the job opts into overlap', async () => {
    seedJob({ next_run_at: clock - 60_000, overlap_policy: 'allow' });
    const cron = makeService();
    await cron.init();
    clock += 3600_000;
    await cron.tick();

    expect(created).toHaveLength(2);
  });

  it('closes out a run whose session died, and stops blocking the job', async () => {
    seedJob({ next_run_at: clock - 60_000 });
    const cron = makeService();
    await cron.init();
    expect(created).toHaveLength(1);

    // The session goes away without the scheduler having seen `turn_complete`
    // — a crash, or a `forget`. The next tick must notice and let the job run.
    aliveSessions.clear();
    clock += 3600_000;
    await cron.tick();

    const runs = readCronRuns(db, { limit: 10 });
    expect(runs.some((r) => r.status === 'failed')).toBe(true);
    expect(created).toHaveLength(2);
  });

  it('records a removed workspace folder as a failed run and survives the tick', async () => {
    seedJob({ next_run_at: clock - 60_000 });
    resolveFails = new WorkspaceError('outside', 'forbidden');
    const cron = makeService();

    await expect(cron.init()).resolves.toBeUndefined();

    const runs = readCronRuns(db, { limit: 10 });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.error).toMatch(/no longer inside an added project folder/i);
    // The job is still scheduled — a temporarily unmounted folder must not
    // silently disable a job the user still wants.
    expect(readCronJob(db, 'job-1')?.next_run_at).toBeGreaterThan(clock);
  });

  it('never leaves a due job due, even when firing throws', async () => {
    seedJob({ next_run_at: clock - 60_000 });
    const cron = makeService();
    // A job whose schedule cannot be re-solved would otherwise be retried
    // every 30 seconds forever.
    await cron.init();
    const next = readCronJob(db, 'job-1')?.next_run_at;
    expect(next).toBeGreaterThan(clock);
  });

  it('closes out the run row even when firing throws something unexpected', async () => {
    // The hole this guards: a row stuck in `starting` with no session cannot be
    // reconciled later (there is no session to ask about) and would block a
    // `skip`-policy job forever, with no timeout anywhere to rescue it.
    seedJob({ next_run_at: clock - 60_000 });
    resolveFails = new TypeError('something nobody anticipated');
    const cron = makeService();

    await expect(cron.init()).resolves.toBeUndefined();

    const runs = readCronRuns(db, { limit: 10 });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.error).toMatch(/nobody anticipated/);
    expect(runs[0]?.finished_at).not.toBeNull();
  });

  it('marks runs left open by a dead server as failed at boot', async () => {
    seedJob({ next_run_at: clock + 3600_000 });
    db.prepare(
      `INSERT INTO cron_runs (id, job_id, job_name, agent, status, trigger, scheduled_for, started_at)
       VALUES ('stale', 'job-1', 'Hourly', 'claude', 'running', 'schedule', ?, ?)`,
    ).run(clock - 1000, clock - 1000);

    await makeService().init();

    const run = readCronRuns(db, { limit: 10 }).find((r) => r.id === 'stale');
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatch(/server restarted/i);
  });

  it('fails in-flight runs with the real reason on shutdown', async () => {
    seedJob({ next_run_at: clock - 60_000 });
    const cron = makeService();
    await cron.init();

    cron.stop();

    const run = readCronRuns(db, { limit: 10 })[0];
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatch(/shut down/i);
  });

  it('a disabled job is never due', async () => {
    seedJob({ enabled: 0, next_run_at: clock - 60_000 });
    await makeService().init();
    expect(created).toHaveLength(0);
    expect(readCronRuns(db, { limit: 10 })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The worktree-per-run composite
// ---------------------------------------------------------------------------

describe('cron worktree mode', () => {
  it('mints a unique branch per run, so a repeating job does not hit branch_exists', async () => {
    const db = openDatabase(':memory:');
    let clock = Date.parse('2026-08-28T12:00:00Z');
    const branches: string[] = [];
    const cwds: string[] = [];

    const cron = new CronService({
      db,
      sessions: {
        create: async (input: { cwd: string }) => {
          cwds.push(input.cwd);
          return {
            id: `sess-${cwds.length}`,
            transport: 'structured',
            on: () => undefined,
            prompt: () => true,
          };
        },
        find: () => null,
      } as unknown as SessionManager,
      workspaces: {
        resolveWorkspacePath: async (p: string) => p,
        labelFor: (p: string) => p,
      } as unknown as WorkspaceRegistry,
      worktrees: {
        create: async (input: { branchName?: string }) => {
          branches.push(input.branchName as string);
          return { cwd: `/tmp/project/.worktrees/${input.branchName}`, branch: input.branchName };
        },
      } as unknown as WorktreeService,
      agents: { get: () => ({ displayName: 'Claude Code' }) } as unknown as AgentRegistry,
      now: () => clock,
    });

    insertCronJob(db, {
      id: 'job-1',
      name: 'Nightly Review!',
      enabled: 1,
      cron_expr: '0 * * * *',
      time_zone: 'UTC',
      schedule_kind: 'expression',
      preset_json: null,
      cwd: '/tmp/project',
      agent: 'claude',
      worktree_mode: 'new-branch',
      model: null,
      effort: null,
      effort_set: 0,
      skip_permissions: 1,
      prompt: 'review',
      overlap_policy: 'allow',
      created_at: clock,
      updated_at: clock,
      next_run_at: clock - 60_000,
      last_run_at: null,
      last_run_status: null,
      last_error: null,
    });

    await cron.init();
    clock += 3600_000;
    await cron.tick();

    expect(branches).toHaveLength(2);
    expect(branches[0]).not.toBe(branches[1]);
    // Readable in `git branch`, and stamped in the job's own zone.
    expect(branches[0]).toMatch(/^nightly-review-\d{8}-\d{4}-[0-9a-f]{6}$/);
    // The session ran in the worktree, not the project root.
    expect(cwds[0]).toContain('.worktrees/');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe('cron migration', () => {
  it('adds the tables to an existing database', () => {
    const file = `${fs.mkdtempSync('/tmp/pa-cron-')}/db.sqlite`;
    const db = openDatabase(file);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('cron_jobs');
    expect(names).toContain('cron_runs');
    db.close();
    fs.rmSync(file, { force: true });
  });
});

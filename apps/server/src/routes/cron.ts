import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  CreateCronJobRequest,
  UpdateCronJobRequest,
  serverTimeZone,
} from '@pocketagent/protocol';
import type { CronJobSpec } from '../cron/index.js';
import { CronServiceError } from '../cron/index.js';
import { resolveWorkspaceCwdOrReply } from './shared.js';

/** Default page size for a run list. Enough to fill a phone screen several times. */
const DEFAULT_RUN_LIMIT = 50;
const MAX_RUN_LIMIT = 200;

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: { code: 'bad_request', message } });
}

/** `Intl` is the whole zero-dependency time-zone validation story. */
function isKnownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const cronRoutes: FastifyPluginAsync = async (app) => {
  const { cron, workspaces, agents } = app.pocket;

  const mapError = (reply: FastifyReply, err: unknown): FastifyReply | never => {
    if (err instanceof CronServiceError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    throw err;
  };

  app.get('/api/cron/jobs', async () => ({
    jobs: cron.list().map((row) => cron.toJob(row)),
  }));

  app.get<{ Params: { id: string } }>('/api/cron/jobs/:id', async (request, reply) => {
    const row = cron.get(request.params.id);
    if (row === null) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such scheduled job.' } });
    }
    return reply.send(cron.toJob(row));
  });

  /**
   * Create a scheduled job.
   *
   * Validation order here is load-bearing: the schedule is checked before the
   * directory, and the directory before the agent, so the first thing the user
   * hears about is the thing they most likely got wrong. Crucially, a schedule
   * with no future occurrence is a 400 rather than a job that sits there
   * silently never firing.
   */
  app.post('/api/cron/jobs', async (request, reply) => {
    const parsed = CreateCronJobRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    const body = parsed.data;

    const timeZone = body.timeZone ?? serverTimeZone();
    if (!isKnownTimeZone(timeZone)) {
      return badRequest(reply, `Unknown time zone "${timeZone}".`);
    }

    const cwd = await resolveWorkspaceCwdOrReply(workspaces, body.cwd, reply);
    if (cwd === null) return reply;

    const agentCheck = checkAgent(body.agent);
    if (agentCheck !== null) return badRequest(reply, agentCheck);

    const spec: CronJobSpec = {
      name: body.name,
      enabled: body.enabled,
      schedule:
        body.preset !== undefined
          ? { kind: 'preset', preset: body.preset }
          : { kind: 'expression', cronExpr: body.cronExpr as string },
      timeZone,
      cwd,
      agent: body.agent,
      worktreeMode: body.worktreeMode,
      model: body.model ?? null,
      ...('effort' in body ? { effort: body.effort ?? null } : {}),
      skipPermissions: body.skipPermissions,
      prompt: body.prompt,
      overlapPolicy: body.overlapPolicy,
    };

    try {
      const row = cron.create(spec);
      if (row.next_run_at === null) {
        // Roll it back rather than leaving a job that can never fire.
        cron.remove(row.id);
        return badRequest(
          reply,
          'That schedule has no future run. Check the day and month you picked.',
        );
      }
      return reply.code(201).send(cron.toJob(row));
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>('/api/cron/jobs/:id', async (request, reply) => {
    const parsed = UpdateCronJobRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    const body = parsed.data;

    if (cron.get(request.params.id) === null) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such scheduled job.' } });
    }

    if (body.timeZone !== undefined && !isKnownTimeZone(body.timeZone)) {
      return badRequest(reply, `Unknown time zone "${body.timeZone}".`);
    }
    if (body.agent !== undefined) {
      const agentCheck = checkAgent(body.agent);
      if (agentCheck !== null) return badRequest(reply, agentCheck);
    }

    let cwd: string | undefined;
    if (body.cwd !== undefined) {
      const resolved = await resolveWorkspaceCwdOrReply(workspaces, body.cwd, reply);
      if (resolved === null) return reply;
      cwd = resolved;
    }

    const patch: Partial<CronJobSpec> = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.timeZone !== undefined ? { timeZone: body.timeZone } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(body.agent !== undefined ? { agent: body.agent } : {}),
      ...(body.worktreeMode !== undefined ? { worktreeMode: body.worktreeMode } : {}),
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...('effort' in body ? { effort: body.effort ?? null } : {}),
      ...(body.skipPermissions !== undefined ? { skipPermissions: body.skipPermissions } : {}),
      ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
      ...(body.overlapPolicy !== undefined ? { overlapPolicy: body.overlapPolicy } : {}),
      ...(body.preset !== undefined
        ? { schedule: { kind: 'preset' as const, preset: body.preset } }
        : body.cronExpr !== undefined
          ? { schedule: { kind: 'expression' as const, cronExpr: body.cronExpr } }
          : {}),
    };

    try {
      const row = cron.update(request.params.id, patch);
      if (row.enabled === 1 && row.next_run_at === null) {
        return badRequest(
          reply,
          'That schedule has no future run. Check the day and month you picked.',
        );
      }
      return reply.send(cron.toJob(row));
    } catch (err) {
      return mapError(reply, err);
    }
  });

  /**
   * Delete a job, keeping its run history.
   *
   * `runsKept` lets the UI offer "also clear N runs" as a second, explicit
   * act — the same discipline that stops "Remove" from deleting a transcript.
   */
  app.delete<{ Params: { id: string } }>('/api/cron/jobs/:id', async (request, reply) => {
    try {
      const { runsKept } = cron.remove(request.params.id);
      return reply.send({ ok: true as const, runsKept });
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/cron/jobs/:id/runs', async (request, reply) => {
    const removed = cron.clearRuns(request.params.id);
    return reply.send({ ok: true as const, removed });
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/api/cron/jobs/:id/runs',
    async (request, reply) =>
      reply.send({
        runs: cron
          .runs({ jobId: request.params.id, limit: parseLimit(request.query.limit) })
          .map((row) => cron.toRun(row)),
      }),
  );

  /** Every job's runs, orphans of deleted jobs included. */
  app.get<{ Querystring: { limit?: string } }>('/api/cron/runs', async (request, reply) =>
    reply.send({
      runs: cron.runs({ limit: parseLimit(request.query.limit) }).map((row) => cron.toRun(row)),
    }),
  );

  /**
   * Fire a job now.
   *
   * 202 with the run row rather than 201 with a session: this awaits the
   * worktree-and-spawn composite (so the row already carries `sessionId` for
   * the client to navigate to) but deliberately not the agent's turn. A
   * failure *inside* the run is a 202 carrying a `failed` row, not a 4xx — the
   * run genuinely happened and belongs in the history like any other.
   *
   * Rate-limited because it is the only route here that spawns a process.
   */
  app.post<{ Params: { id: string } }>(
    '/api/cron/jobs/:id/run',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      try {
        const run = await cron.runNow(request.params.id);
        return reply.code(202).send(cron.toRun(run));
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  /**
   * A cron job is always a structured session.
   *
   * Refused rather than silently downgraded: delivering a prompt to a terminal
   * session means writing keystrokes into a TUI with no readiness signal and no
   * way to tell a finished turn from a hung one, which is exactly the judgement
   * `terminal/classifier.ts` must never make.
   */
  function checkAgent(id: string): string | null {
    const adapter = agents.get(id);
    if (adapter === undefined) return `No such agent "${id}".`;
    if (!adapter.transports.includes('structured')) {
      return `${adapter.displayName} cannot be scheduled: it has no structured mode, and a scheduled run has nobody to type at a terminal.`;
    }
    return null;
  }
};

function parseLimit(raw: string | undefined): number {
  const n = raw === undefined ? DEFAULT_RUN_LIMIT : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RUN_LIMIT;
  return Math.min(Math.floor(n), MAX_RUN_LIMIT);
}

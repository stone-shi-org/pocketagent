import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  CreateCronJobRequest,
  UpdateCronJobRequest,
  serverTimeZone,
} from '@pocketagent/protocol';
import type { CronJobSpec } from '../cron/index.js';
import { CronServiceError } from '../cron/index.js';
import type { WorkspaceRegistry } from '../workspaces/index.js';
import { WorkspaceError } from '../workspaces/index.js';
import type { PlannerWorkspaceRegistry } from '../planner/workspaces.js';
import type { AgentRegistry } from '../agents/registry.js';
import { auditConfigChange, resolveWorkspaceCwdOrReply, structuredAgentProblem } from './shared.js';

/** Default page size for a run list. Enough to fill a phone screen several times. */
const DEFAULT_RUN_LIMIT = 50;
const MAX_RUN_LIMIT = 200;

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: { code: 'bad_request', message } });
}

/** `Intl` is the whole zero-dependency time-zone validation story. */
export function isKnownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * A cron job is always a structured session. See `structuredAgentProblem`.
 * Exported (alongside `resolveCronJobUpdatePatch` below) so `update_cron_job`
 * (a planner tool, `planner/tools.ts`) runs the exact same check on a patch
 * that touches `agent`, rather than a second copy that could drift from it.
 */
export function checkCronAgent(agents: AgentRegistry, id: string): string | null {
  if (id === 'pocketagent') return null;
  return structuredAgentProblem(agents, id, 'scheduled');
}

export interface CronJobUpdateDeps {
  workspaces: WorkspaceRegistry;
  plannerWorkspaces: PlannerWorkspaceRegistry;
  agents: AgentRegistry;
}

export type CronJobUpdatePatchResult =
  | { ok: true; patch: Partial<CronJobSpec> }
  | { ok: false; error: string };

/**
 * PA-56: the validated-patch half of `PATCH /api/cron/jobs/:id`, pulled out
 * so the planner tool above can run the exact same checks — known time zone,
 * the `agent`/`cwd` coupling (a Pocket Agent's `cwd` resolves against
 * `plannerWorkspaces`, everything else against `workspaces`), and
 * `checkCronAgent`'s unattended-use rule — instead of a second copy that
 * could silently stop matching the route's. Takes the job's *current*
 * `agent` rather than an id, since both callers already have the row in
 * hand and a second fetch here would just be a race waiting to happen.
 */
export async function resolveCronJobUpdatePatch(
  deps: CronJobUpdateDeps,
  existingAgent: string,
  body: UpdateCronJobRequest,
): Promise<CronJobUpdatePatchResult> {
  if (body.timeZone !== undefined && !isKnownTimeZone(body.timeZone)) {
    return { ok: false, error: `Unknown time zone "${body.timeZone}".` };
  }
  if (body.agent !== undefined) {
    const agentCheck = checkCronAgent(deps.agents, body.agent);
    if (agentCheck !== null) return { ok: false, error: agentCheck };
  }

  const targetAgent = body.agent ?? existingAgent;
  let cwd: string | undefined;
  if (body.cwd !== undefined) {
    if (targetAgent === 'pocketagent') {
      const plannerWs =
        deps.plannerWorkspaces.list().find((w) => w.path === body.cwd || w.id === body.cwd) ??
        deps.plannerWorkspaces.getDefault();
      if (!plannerWs) return { ok: false, error: 'No Pocket Agent workspace found.' };
      cwd = plannerWs.path;
    } else {
      try {
        cwd = await deps.workspaces.resolveWorkspacePath(body.cwd);
      } catch (err) {
        if (err instanceof WorkspaceError) return { ok: false, error: err.message };
        throw err;
      }
    }
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
    ...(body.retentionDays !== undefined ? { retentionDays: body.retentionDays } : {}),
    ...(body.preset !== undefined
      ? { schedule: { kind: 'preset' as const, preset: body.preset } }
      : body.cronExpr !== undefined
        ? { schedule: { kind: 'expression' as const, cronExpr: body.cronExpr } }
        : {}),
  };
  return { ok: true, patch };
}

export const cronRoutes: FastifyPluginAsync = async (app) => {
  const { cron, workspaces, agents, plannerWorkspaces } = app.pocket;

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

    let cwd: string;
    if (body.agent === 'pocketagent') {
      const plannerWs = plannerWorkspaces.list().find((w) => w.path === body.cwd || w.id === body.cwd)
        ?? plannerWorkspaces.getDefault();
      if (!plannerWs) {
        return badRequest(reply, 'No Pocket Agent workspace found.');
      }
      cwd = plannerWs.path;
    } else {
      const resolved = await resolveWorkspaceCwdOrReply(workspaces, body.cwd, reply);
      if (resolved === null) return reply;
      cwd = resolved;
    }

    const agentCheck = checkCronAgent(agents, body.agent);
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
      retentionDays: body.retentionDays ?? 10,
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

    const existing = cron.get(request.params.id);
    if (existing === null) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such scheduled job.' } });
    }

    const result = await resolveCronJobUpdatePatch(
      { workspaces, plannerWorkspaces, agents },
      existing.agent,
      parsed.data,
    );
    if (!result.ok) return badRequest(reply, result.error);

    try {
      const row = cron.update(request.params.id, result.patch);
      if (row.enabled === 1 && row.next_run_at === null) {
        return badRequest(
          reply,
          'That schedule has no future run. Check the day and month you picked.',
        );
      }
      auditConfigChange(request, 'cron job updated', {
        jobId: request.params.id,
        fields: Object.keys(result.patch),
      });
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

};

function parseLimit(raw: string | undefined): number {
  const n = raw === undefined ? DEFAULT_RUN_LIMIT : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RUN_LIMIT;
  return Math.min(Math.floor(n), MAX_RUN_LIMIT);
}

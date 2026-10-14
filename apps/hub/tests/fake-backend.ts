import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * PA-70: a backend that implements just the routes the provisioner calls, with
 * real state.
 *
 * Deliberately not `startStubBackend` (which answers one canned response) and
 * deliberately not a real PocketAgent server for most suites. What these tests
 * assert is *sequences* against state — created, then overwritten in place
 * rather than duplicated; a ledger id that still resolves; a tool the catalog
 * does not have refused while the rest applies — and a canned responder cannot
 * express any of that. `templates-audit.test.ts` is the one suite that uses the
 * real backend, because the thing it checks is the backend's own log line.
 *
 * Every request is recorded, so a test can assert what the Hub *did not* do —
 * "never dialed" and "wrote nothing" are the two properties here that a status
 * code alone cannot prove.
 */

export interface FakeWorkspace {
  id: string;
  name: string;
  defaultModelId: string | null;
  identityPrompt: string | null;
  memoryEnabled: boolean;
  mcpEnabled: boolean;
  disabledTools: string[];
}

export interface FakeSkill {
  id: string;
  slug: string;
  name: string;
  description: string;
  body: string;
}

export interface FakeBackend {
  baseUrl: string;
  requests: { method: string; path: string; body: unknown }[];
  workspaces: FakeWorkspace[];
  registries: { id: string; name: string; url: string; bearerToken?: string; headerValue?: string }[];
  providers: { id: string; name: string; baseUrl: string; apiKey?: string; allowUnattended?: boolean }[];
  plannerProviders: {
    id: string;
    label: string;
    kind: string;
    baseUrl: string;
    apiKey?: string;
    allowUnattended?: boolean;
  }[];
  skills: FakeSkill[];
  models: { id: string; providerId?: string; modelId: string; label: string }[];
  settings: Record<string, unknown>;
  /** Tool names this build knows about; anything else is a 400, as the real
      route's catalog check produces. */
  knownTools: Set<string>;
  /** Paths to answer 404 for, so "that build has no such feature" is testable. */
  missingPaths: Set<string>;
  /** When set, every request is answered 401 — a revoked credential. */
  rejectCredential: boolean;
  close: () => Promise<void>;
}

export async function startFakeBackend(): Promise<FakeBackend> {
  // One object, closed over by the handler *and* returned, rather than a
  // private `state` spread into the result. A spread copies the scalar fields
  // by value, so a test flipping `rejectCredential` would set it on a
  // different object than the handler reads — the kind of bug that makes a
  // test silently assert nothing.
  const state: FakeBackend = {
    baseUrl: '',
    close: async () => {},
    requests: [],
    workspaces: [],
    registries: [],
    providers: [],
    plannerProviders: [],
    skills: [],
    models: [],
    settings: { baseUrl: null, hasApiKey: false },
    knownTools: new Set(['write_file', 'exec_command', 'send_instruction']),
    missingPaths: new Set(),
    rejectCredential: false,
  };
  let nextId = 1;

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      const method = request.method ?? 'GET';
      const rawUrl = request.url ?? '/';
      const path = rawUrl.split('?')[0] ?? '/';
      const query = new URLSearchParams(rawUrl.split('?')[1] ?? '');
      state.requests.push({ method, path, body });

      const send = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload ?? null));
      };
      const notFound = (): void => send(404, { error: { code: 'not_found', message: 'Not found.' } });

      if (state.rejectCredential) {
        send(401, { error: { code: 'unauthorized', message: 'Authentication required.' } });
        return;
      }
      if (state.missingPaths.has(path)) {
        notFound();
        return;
      }

      // ---- Pocket Agents ---------------------------------------------------
      if (path === '/api/planner/workspaces' && method === 'GET') {
        send(200, { workspaces: state.workspaces });
        return;
      }
      if (path === '/api/planner/workspaces' && method === 'POST') {
        const created: FakeWorkspace = {
          id: `ws-${nextId++}`,
          name: String((body as { name?: string } | null)?.name ?? ''),
          defaultModelId: null,
          identityPrompt: null,
          memoryEnabled: true,
          mcpEnabled: true,
          disabledTools: [],
        };
        state.workspaces.push(created);
        send(201, created);
        return;
      }
      const wsTools = /^\/api\/planner\/workspaces\/([^/]+)\/tools$/.exec(path);
      if (wsTools && method === 'POST') {
        const ws = state.workspaces.find((w) => w.id === decodeURIComponent(wsTools[1]!));
        if (!ws) return notFound();
        const toolName = String((body as { toolName?: string } | null)?.toolName ?? '');
        if (!state.knownTools.has(toolName)) {
          // What the real route does: the tool subset is validated against
          // this host's live catalog, so an unknown name is a 400.
          send(400, { error: { code: 'bad_request', message: `Unknown tool: ${toolName}` } });
          return;
        }
        ws.disabledTools.push(toolName);
        send(200, { tools: [] });
        return;
      }
      const wsOne = /^\/api\/planner\/workspaces\/([^/]+)$/.exec(path);
      if (wsOne && method === 'PATCH') {
        const ws = state.workspaces.find((w) => w.id === decodeURIComponent(wsOne[1]!));
        if (!ws) return notFound();
        Object.assign(ws, body as Record<string, unknown>);
        send(200, ws);
        return;
      }

      // ---- MCP registries --------------------------------------------------
      if (path === '/api/mcp-registries' && method === 'GET') {
        send(200, { registries: state.registries, encryptionAvailable: true });
        return;
      }
      if (path === '/api/mcp-registries' && method === 'POST') {
        const created = { id: `mcp:reg-${nextId++}`, ...(body as Record<string, unknown>) } as (typeof state.registries)[number];
        state.registries.push(created);
        send(201, created);
        return;
      }
      const regOne = /^\/api\/mcp-registries\/([^/]+)$/.exec(path);
      if (regOne && method === 'PATCH') {
        const reg = state.registries.find((r) => r.id === decodeURIComponent(regOne[1]!));
        if (!reg) return notFound();
        Object.assign(reg, body as Record<string, unknown>);
        send(200, reg);
        return;
      }

      // ---- Providers -------------------------------------------------------
      if (path === '/api/custom-claude-providers' && method === 'GET') {
        send(200, { providers: state.providers, encryptionAvailable: true });
        return;
      }
      if (path === '/api/custom-claude-providers' && method === 'POST') {
        const created = {
          id: `custom-claude:p-${nextId++}`,
          ...(body as Record<string, unknown>),
        } as (typeof state.providers)[number];
        state.providers.push(created);
        send(201, created);
        return;
      }
      const provOne = /^\/api\/custom-claude-providers\/([^/]+)$/.exec(path);
      if (provOne && method === 'PATCH') {
        const provider = state.providers.find((p) => p.id === decodeURIComponent(provOne[1]!));
        if (!provider) return notFound();
        Object.assign(provider, body as Record<string, unknown>);
        send(200, provider);
        return;
      }

      // ---- Skills ----------------------------------------------------------
      if (path === '/api/planner/skills' && method === 'GET') {
        send(200, { skills: state.skills });
        return;
      }
      if (path === '/api/planner/skills/import' && method === 'POST') {
        const input = body as {
          slug: string;
          name: string;
          description: string;
          body: string;
          overwrite?: boolean;
        };
        const existing = state.skills.find((s) => s.slug === input.slug);
        if (existing && input.overwrite !== true) {
          send(409, {
            error: { code: 'invalid', message: `A global skill named "${input.slug}" already exists.` },
          });
          return;
        }
        const skill: FakeSkill = {
          id: `global:${input.slug}`,
          slug: input.slug,
          name: input.name,
          description: input.description,
          body: input.body,
        };
        if (existing) Object.assign(existing, skill);
        else state.skills.push(skill);
        send(201, skill);
        return;
      }

      // ---- Planner providers + model catalog (PA-148) ----------------------
      if (path === '/api/planner/providers' && method === 'GET') {
        send(200, { providers: state.plannerProviders, encryptionAvailable: true });
        return;
      }
      if (path === '/api/planner/providers' && method === 'POST') {
        const created = {
          id: `pp-${nextId++}`,
          kind: 'openai-compatible',
          ...(body as Record<string, unknown>),
        } as (typeof state.plannerProviders)[number];
        state.plannerProviders.push(created);
        send(201, created);
        return;
      }
      const plannerProvOne = /^\/api\/planner\/providers\/([^/]+)$/.exec(path);
      if (plannerProvOne && method === 'PATCH') {
        const provider = state.plannerProviders.find((p) => p.id === decodeURIComponent(plannerProvOne[1]!));
        if (!provider) return notFound();
        Object.assign(provider, body as Record<string, unknown>);
        send(200, provider);
        return;
      }

      // ---- Planner endpoint + model catalog --------------------------------
      if (path === '/api/planner/settings' && method === 'GET') {
        send(200, state.settings);
        return;
      }
      if (path === '/api/planner/settings' && method === 'PATCH') {
        Object.assign(state.settings, body as Record<string, unknown>);
        send(200, state.settings);
        return;
      }
      if (path === '/api/planner/models' && method === 'GET') {
        const filterProviderId = query.get('providerId');
        const models = filterProviderId
          ? state.models.filter((m) => m.providerId === filterProviderId)
          : state.models;
        send(200, { models });
        return;
      }
      if (path === '/api/planner/models' && method === 'DELETE') {
        const filterProviderId = query.get('providerId');
        if (filterProviderId) {
          state.models = state.models.filter((m) => m.providerId !== filterProviderId);
        } else {
          state.models.length = 0;
        }
        response.writeHead(204);
        response.end();
        return;
      }
      if (path === '/api/planner/models' && method === 'POST') {
        const input = body as { providerId?: string; modelId: string; label: string };
        const created = {
          id: `m-${nextId++}`,
          providerId: input.providerId,
          modelId: input.modelId,
          label: input.label,
        };
        state.models.push(created);
        send(201, created);
        return;
      }

      notFound();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  state.baseUrl = `http://127.0.0.1:${address.port}`;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}

/** Requests that wrote something — what "nothing was written" asserts on. */
export function writes(backend: FakeBackend): { method: string; path: string }[] {
  return backend.requests
    .filter((r) => r.method !== 'GET')
    .map((r) => ({ method: r.method, path: r.path }));
}

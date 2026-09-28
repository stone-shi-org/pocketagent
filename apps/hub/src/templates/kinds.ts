import {
  isMcpRegistryBundle,
  mcpRegistriesFromPayload,
  type HubTemplatePayload,
  type ProvisioningItem,
} from '@pocketagent/protocol';

/**
 * PA-70: how a template payload becomes calls against a backend's *existing*
 * API.
 *
 * This module is the whole of "provisioning is the Hub being an API client".
 * Every path below already exists on a PocketAgent backend and is already
 * validated there — which is the point, and is the same rule PA-56 recorded
 * when the planner needed to write settings: run through the same validation
 * the route does, never a second copy. A `POST /api/provision` taking five
 * resource kinds would have been five re-implementations of five validators,
 * and the first one to drift would have drifted silently on every bound host
 * at once.
 *
 * One consequence worth being explicit about: because these are ordinary
 * routes, a backend's own audit line fires for each of them (see
 * `auditConfigChange`), which is how "logged on both sides" is satisfied
 * without the Hub asking the backend to log anything.
 */

export interface BackendCall {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
}

export interface BackendCallResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
  readonly transportError: string | null;
}

/**
 * One call after the resource exists.
 *
 * `optional` is the interesting field and it exists for a real failure, not a
 * hypothetical one: a Pocket Agent's `disabledTools` is validated against the
 * *receiving host's* live tool catalog, so a host one release behind answers
 * `400` for a name it has never heard of. Failing the whole provisioning there
 * would be wrong — the agent was created and is usable — so an optional step
 * that fails is reported as one item and the run continues.
 */
export interface ProvisionStep {
  readonly label: string;
  readonly call: BackendCall;
  readonly optional: boolean;
}

export interface ProvisionPlan {
  /**
   * Probed with a `GET` before anything is written.
   *
   * Two jobs in one request: a `404` here means this build has no such feature
   * (reported as `unsupported`, never written to), and the body is what
   * existence and collision checks read. Feature detection is deliberately a
   * probe rather than a semver comparison — a backport, a dev build or
   * `0.0.0-dev` makes a version number a lie about which routes exist.
   */
  readonly collectionPath: string;
  /** Ids present on the host, so a ledger row can be confirmed or dropped. */
  existingIds(body: unknown): string[];
  /**
   * Something already on the host that this template would duplicate.
   *
   * Only meaningful where the *host* enforces uniqueness. Skills are the one
   * such kind (the slug is a directory name), which is why this returns null
   * for the others: no backend table constrains a Pocket Agent's, a
   * registry's or a provider's name, so two may legitimately share one, and
   * treating a name match as "already provisioned" could overwrite something a
   * human made by hand — exactly the implicit overwrite this ticket forbids.
   */
  collision(body: unknown): { remoteId: string; label: string } | null;
  /** Null for a singleton kind: there is nothing to create, only to replace. */
  readonly createCall: BackendCall | null;
  /** Read the new resource's id out of the create response. */
  remoteIdFrom(body: unknown): string | null;
  /** The call that rewrites an existing resource in place. */
  updateCall(remoteId: string): BackendCall | null;
  /**
   * True when `updateCall` has to run immediately after `createCall` as well.
   *
   * Only `pocket-agent` needs it: `POST /api/planner/workspaces` accepts a
   * name and nothing else, so the model, persona and toggles arrive in a
   * follow-up `PATCH`. Stated as a flag rather than by folding the patch into
   * the step list, because "the create call was not enough on its own" is the
   * thing a reader needs to know.
   */
  readonly updateAfterCreate: boolean;
  /** Everything else, run for both a create and an overwrite. */
  steps(remoteId: string): ProvisionStep[];
  /** A singleton has a fixed ledger id and skips create/collision entirely. */
  readonly singletonRemoteId: string | null;
  /** Optional custom writer for bundled multi-resource templates. */
  readonly executeWrite?: (
    outcome: 'provisioned' | 'overwritten',
    remoteId: string | null,
    call: (c: BackendCall) => Promise<BackendCallResult>,
    hostLabel: string,
    existingIds: string[],
  ) => Promise<
    | { ok: true; remoteId: string | null; items: ProvisioningItem[] }
    | { ok: false; error: string; remoteId: string | null; items: ProvisioningItem[] }
  >;
}

/** Secrets for one run, keyed by `SecretHole.key`. */
export type FilledSecrets = Readonly<Record<string, string | undefined>>;

function idsFrom(body: unknown, key: string): string[] {
  const list = (body as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (item as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string');
}

export function planFor(spec: HubTemplatePayload, secrets: FilledSecrets): ProvisionPlan {
  switch (spec.kind) {
    case 'pocket-agent': {
      const p = spec.payload;
      return {
        collectionPath: '/api/planner/workspaces',
        existingIds: (body) => idsFrom(body, 'workspaces'),
        collision: () => null,
        // Deliberately `name` only — and deliberately *no* `path`/`createPath`,
        // which the template schema does not even carry. Instantiation always
        // takes the app-created-scratch-directory branch, so the receiving
        // host mints a directory under its own data root rather than being
        // handed an absolute path that is wrong everywhere but where it was
        // typed.
        createCall: { method: 'POST', path: '/api/planner/workspaces', body: { name: p.name } },
        remoteIdFrom: (body) => {
          const id = (body as { id?: unknown } | null)?.id;
          return typeof id === 'string' ? id : null;
        },
        updateCall: (remoteId) => ({
          method: 'PATCH',
          path: `/api/planner/workspaces/${encodeURIComponent(remoteId)}`,
          body: {
            name: p.name,
            defaultModelId: p.defaultModelId,
            identityPrompt: p.identityPrompt,
            memoryEnabled: p.memoryEnabled,
            mcpEnabled: p.mcpEnabled,
          },
        }),
        updateAfterCreate: true,
        // One call per tool, because that is the route's shape
        // (`{ toolName, enabled }`). Optional for the reason `ProvisionStep`
        // records. Note the deny-list semantics carry over intact: only what
        // this template turns *off* is sent, so a tool the host gained later
        // is enabled there without the template having to know it exists.
        steps: (remoteId) =>
          p.disabledTools.map((toolName) => ({
            label: `disable ${toolName}`,
            optional: true,
            call: {
              method: 'POST' as const,
              path: `/api/planner/workspaces/${encodeURIComponent(remoteId)}/tools`,
              body: { toolName, enabled: false },
            },
          })),
        singletonRemoteId: null,
      };
    }

    case 'mcp-registry': {
      const registries = mcpRegistriesFromPayload(spec.payload);
      const isBundle = isMcpRegistryBundle(spec.payload) && registries.length > 1;

      if (!isBundle) {
        const p = registries[0]!;
        // The secret is spliced in here and nowhere else. `authKind: 'none'`
        // sends neither field, which is what the backend's own `.refine` on
        // that request expects.
        const auth =
          p.authKind === 'bearer'
            ? { bearerToken: secrets.bearerToken ?? secrets.bearerToken_0 }
            : p.authKind === 'header'
              ? { headerName: p.headerName, headerValue: secrets.headerValue ?? secrets.headerValue_0 }
              : {};
        const body = {
          name: p.name,
          transport: p.transport,
          url: p.url,
          authKind: p.authKind,
          enabled: p.enabled,
          ...(p.description === null ? {} : { description: p.description }),
          ...auth,
        };
        return {
          collectionPath: '/api/mcp-registries',
          existingIds: (b) => idsFrom(b, 'registries'),
          collision: () => null,
          createCall: { method: 'POST', path: '/api/mcp-registries', body },
          remoteIdFrom: (b) => {
            const id = (b as { id?: unknown } | null)?.id;
            return typeof id === 'string' ? id : null;
          },
          updateCall: (remoteId) => ({
            method: 'PATCH',
            path: `/api/mcp-registries/${encodeURIComponent(remoteId)}`,
            body,
          }),
          updateAfterCreate: false,
          steps: () => [],
          singletonRemoteId: null,
        };
      }

      // Bundled MCP registries (PA-111):
      const bodies = registries.map((p, i) => {
        const bearerToken = secrets[`bearerToken_${i}`] ?? (i === 0 ? secrets.bearerToken : undefined);
        const headerValue = secrets[`headerValue_${i}`] ?? (i === 0 ? secrets.headerValue : undefined);
        const auth =
          p.authKind === 'bearer'
            ? { bearerToken }
            : p.authKind === 'header'
              ? { headerName: p.headerName, headerValue }
              : {};
        return {
          name: p.name,
          transport: p.transport,
          url: p.url,
          authKind: p.authKind,
          enabled: p.enabled,
          ...(p.description === null ? {} : { description: p.description }),
          ...auth,
        };
      });

      return {
        collectionPath: '/api/mcp-registries',
        existingIds: (b) => idsFrom(b, 'registries'),
        collision: () => null,
        createCall: null,
        remoteIdFrom: () => null,
        updateCall: () => null,
        updateAfterCreate: false,
        steps: () => [],
        singletonRemoteId: null,
        executeWrite: async (outcome, remoteId, call, hostLabel, existingIds) => {
          const items: ProvisioningItem[] = [];
          const activeIds: string[] = [];

          let prevIds: string[] = [];
          if (remoteId !== null) {
            try {
              const parsed = JSON.parse(remoteId);
              if (Array.isArray(parsed)) {
                prevIds = parsed.filter((id): id is string => typeof id === 'string');
              } else if (typeof parsed === 'string') {
                prevIds = [parsed];
              }
            } catch {
              prevIds = [remoteId];
            }
          }

          for (let i = 0; i < registries.length; i++) {
            const reg = registries[i]!;
            const body = bodies[i]!;
            const prevId = prevIds[i];

            if (outcome === 'overwritten' && prevId && existingIds.includes(prevId)) {
              const res = await call({
                method: 'PATCH',
                path: `/api/mcp-registries/${encodeURIComponent(prevId)}`,
                body,
              });
              if (res.transportError !== null) {
                return {
                  ok: false,
                  error: `Could not reach ${hostLabel}: ${res.transportError}`,
                  remoteId: activeIds.length > 0 ? (activeIds.length === 1 ? activeIds[0]! : JSON.stringify(activeIds)) : remoteId,
                  items,
                };
              }
              if (!res.ok) {
                const why = (res.body as { error?: { message?: unknown } } | null)?.error?.message;
                return {
                  ok: false,
                  error: `${hostLabel} refused update for "${reg.name}": ${typeof why === 'string' ? why : `HTTP ${res.status}`}`,
                  remoteId: activeIds.length > 0 ? (activeIds.length === 1 ? activeIds[0]! : JSON.stringify(activeIds)) : remoteId,
                  items,
                };
              }
              activeIds.push(prevId);
              items.push({ label: `update MCP registry "${reg.name}"`, ok: true, message: 'updated' });
            } else {
              const res = await call({
                method: 'POST',
                path: '/api/mcp-registries',
                body,
              });
              if (res.transportError !== null) {
                return {
                  ok: false,
                  error: `Could not reach ${hostLabel}: ${res.transportError}`,
                  remoteId: activeIds.length > 0 ? (activeIds.length === 1 ? activeIds[0]! : JSON.stringify(activeIds)) : remoteId,
                  items,
                };
              }
              if (!res.ok) {
                const why = (res.body as { error?: { message?: unknown } } | null)?.error?.message;
                return {
                  ok: false,
                  error: `${hostLabel} refused to create "${reg.name}": ${typeof why === 'string' ? why : `HTTP ${res.status}`}`,
                  remoteId: activeIds.length > 0 ? (activeIds.length === 1 ? activeIds[0]! : JSON.stringify(activeIds)) : remoteId,
                  items,
                };
              }
              const createdId = (res.body as { id?: unknown } | null)?.id;
              if (typeof createdId !== 'string') {
                return {
                  ok: false,
                  error: `${hostLabel} created "${reg.name}" without an id.`,
                  remoteId: activeIds.length > 0 ? (activeIds.length === 1 ? activeIds[0]! : JSON.stringify(activeIds)) : remoteId,
                  items,
                };
              }
              activeIds.push(createdId);
              items.push({ label: `create MCP registry "${reg.name}"`, ok: true, message: 'created' });
            }
          }

          const finalRemoteId = activeIds.length === 1 ? activeIds[0]! : JSON.stringify(activeIds);
          return { ok: true, remoteId: finalRemoteId, items };
        },
      };
    }

    case 'claude-provider': {
      const p = spec.payload;
      const body = {
        name: p.name,
        providerKind: p.providerKind,
        baseUrl: p.baseUrl,
        models: p.models,
        defaultModel: p.defaultModel,
        smallModel: p.smallModel,
        allowUnattended: p.allowUnattended,
        apiKey: secrets.apiKey,
      };
      return {
        collectionPath: '/api/custom-claude-providers',
        existingIds: (b) => idsFrom(b, 'providers'),
        collision: () => null,
        createCall: { method: 'POST', path: '/api/custom-claude-providers', body },
        remoteIdFrom: (b) => {
          const id = (b as { id?: unknown } | null)?.id;
          return typeof id === 'string' ? id : null;
        },
        updateCall: (remoteId) => ({
          method: 'PATCH',
          path: `/api/custom-claude-providers/${encodeURIComponent(remoteId)}`,
          body,
        }),
        updateAfterCreate: false,
        steps: () => [],
        singletonRemoteId: null,
      };
    }

    case 'skill': {
      const p = spec.payload;
      // `global:<slug>` is the backend's own id shape for a global skill
      // (`mintSkillId`), which is why the template carries the slug verbatim
      // rather than letting each host derive one: the ledger has to be able to
      // name what it created.
      const remoteId = `global:${p.slug}`;
      const body = { slug: p.slug, name: p.name, description: p.description, body: p.body };
      return {
        collectionPath: '/api/planner/skills',
        existingIds: (b) => idsFrom(b, 'skills'),
        // The one kind with a real host-side uniqueness constraint: the slug
        // is a directory name. A pre-existing skill at this slug that *this*
        // Hub did not provision is a conflict the operator has to resolve, not
        // something an overwrite flag should silently replace — it is most
        // likely a skill somebody wrote on that machine.
        collision: (b) =>
          idsFrom(b, 'skills').includes(remoteId)
            ? { remoteId, label: `a global skill already exists at slug "${p.slug}"` }
            : null,
        createCall: {
          method: 'POST',
          path: '/api/planner/skills/import',
          body: { ...body, overwrite: false },
        },
        remoteIdFrom: (b) => {
          const id = (b as { id?: unknown } | null)?.id;
          return typeof id === 'string' ? id : remoteId;
        },
        updateCall: () => ({
          method: 'POST',
          path: '/api/planner/skills/import',
          body: { ...body, overwrite: true },
        }),
        updateAfterCreate: false,
        steps: () => [],
        singletonRemoteId: null,
      };
    }

    case 'planner-endpoint': {
      const p = spec.payload;
      // The singleton. There is nothing to create and nothing to look up:
      // every host already has exactly one planner endpoint, so provisioning
      // this kind is always a replacement of host-wide configuration — which
      // is why the ledger id is a constant and why the confirmation names what
      // it is about to repoint.
      //
      // A blank optional key is *omitted* rather than sent as an empty string:
      // the backend reads `''` as "clear the stored key", and a template whose
      // operator left the embedding key blank means "leave whatever is there",
      // not "wipe it".
      const settings: Record<string, unknown> = {
        baseUrl: p.baseUrl,
        ...(secrets.apiKey ? { apiKey: secrets.apiKey } : {}),
        embeddingBaseUrl: p.embeddingBaseUrl,
        embeddingModelId: p.embeddingModelId,
        ...(secrets.embeddingApiKey ? { embeddingApiKey: secrets.embeddingApiKey } : {}),
        webSearchBaseUrl: p.webSearchBaseUrl,
        ...(secrets.webSearchApiKey ? { webSearchApiKey: secrets.webSearchApiKey } : {}),
        urlFetchBaseUrl: p.urlFetchBaseUrl,
        ...(secrets.urlFetchApiKey ? { urlFetchApiKey: secrets.urlFetchApiKey } : {}),
      };
      return {
        collectionPath: '/api/planner/settings',
        existingIds: () => [],
        collision: () => null,
        createCall: null,
        remoteIdFrom: () => 'planner-settings',
        updateCall: () => ({ method: 'PATCH', path: '/api/planner/settings', body: settings }),
        updateAfterCreate: false,
        // The model catalog is replaced wholesale, and only when the template
        // actually carries one: `models: []` means "do not touch the catalog",
        // because a template that only sets an endpoint should not empty the
        // list of models an operator curated on that host. When it does carry
        // models, delete-all-then-add is the only shape available — a model row
        // has no PATCH, by that route's own design.
        steps: () =>
          p.models.length === 0
            ? []
            : [
                {
                  label: 'clear the model catalog',
                  optional: false,
                  call: { method: 'DELETE' as const, path: '/api/planner/models' },
                },
                ...p.models.map((model) => ({
                  label: `add model ${model.modelId}`,
                  optional: false,
                  call: {
                    method: 'POST' as const,
                    path: '/api/planner/models',
                    body: { modelId: model.modelId, label: model.label },
                  },
                })),
              ],
        singletonRemoteId: 'planner-settings',
      };
    }
  }
}

/** One line naming what a template does, for a log or a confirmation. */
export function describeSpec(spec: HubTemplatePayload): string {
  switch (spec.kind) {
    case 'pocket-agent':
      return `Pocket Agent "${spec.payload.name}"`;
    case 'mcp-registry': {
      const regs = mcpRegistriesFromPayload(spec.payload);
      if (regs.length === 1) {
        return `MCP registry "${regs[0]!.name}" (${regs[0]!.url})`;
      }
      return `MCP registries (${regs.length} registries: ${regs.map((r) => r.name).join(', ')})`;
    }
    case 'claude-provider':
      return `Claude provider "${spec.payload.name}" (${spec.payload.baseUrl})`;
    case 'skill':
      return `skill "${spec.payload.name}" (${spec.payload.slug})`;
    case 'planner-endpoint':
      return `planner endpoint ${spec.payload.baseUrl}`;
  }
}

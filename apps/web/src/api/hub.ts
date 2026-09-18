import {
  HubHostListResponse,
  HubTemplateListResponse,
  InstantiateHubTemplateResponse,
  type CreateHubTemplateRequest,
  type HubTemplate,
  type InstantiateHubTemplateRequest,
  type ProvisioningResult,
  type HubHostEntry,
  type UpdateHubTemplateRequest,
} from '@pocketagent/protocol';
import { ApiError } from './client.js';

/**
 * The Hub's own API — its host registry (PA-66) and its config templates
 * (PA-70).
 *
 * Deliberately *not* part of `createApiClient`: every method there takes a
 * `HostEndpoint` and reaches one backend through its `/h/<id>/` prefix, and
 * these five routes are the opposite — they live on the origin that served
 * this bundle, which with a Hub in front is the Hub itself. Adding them to the
 * host-scoped client would make "which machine does this call go to" a
 * question with two answers, and the wrong one is silent (see
 * `hosts/host-scoping.test.ts`).
 *
 * Plain `fetch` with `credentials: 'same-origin'`, exactly as
 * `hosts/directory.ts` already does for `/api/hub/hosts`: one relative path,
 * the browser attaches the HttpOnly Hub session cookie, and nothing here ever
 * sees a token.
 */
async function hubRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'content-type': 'application/json' } : { accept: 'application/json' },
    ...init,
  });

  const text = await response.text();
  let body: unknown;
  try {
    body = text === '' ? {} : JSON.parse(text);
  } catch {
    throw new ApiError(
      `Unexpected response from the Hub (${response.status}).`,
      response.status,
      'bad_response',
    );
  }

  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } }).error;
    // Kept as an `ApiError` so a 401 here reaches `App`'s single handler and
    // drops to the login screen like any other — authenticating is per origin,
    // and with a Hub in front that origin is the Hub.
    throw new ApiError(
      error?.message ?? `The Hub refused that (${response.status}).`,
      response.status,
      error?.code ?? 'hub_error',
    );
  }
  return body as T;
}

/**
 * Every template this Hub holds.
 *
 * The one response here that is *parsed* rather than cast, for the reason
 * `probeHostInfo` gives for `/api/hosts`: this is also the probe that decides
 * whether a Hub is answering at all (a backend serves a JSON 404 for anything
 * under `/api/` it does not know), so "did not parse" has to be a clean
 * negative rather than a crash in a `map`.
 */
export async function listHubTemplates(): Promise<HubTemplate[]> {
  const body = await hubRequest<unknown>('/api/hub/templates');
  const parsed = HubTemplateListResponse.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('This origin is not a PocketAgent Hub.', 404, 'not_a_hub');
  }
  return parsed.data.templates;
}

export async function createHubTemplate(body: CreateHubTemplateRequest): Promise<HubTemplate> {
  const { template } = await hubRequest<{ template: HubTemplate }>('/api/hub/templates', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return template;
}

export async function updateHubTemplate(
  id: string,
  body: UpdateHubTemplateRequest,
): Promise<HubTemplate> {
  const { template } = await hubRequest<{ template: HubTemplate }>(
    `/api/hub/templates/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  return template;
}

export async function deleteHubTemplate(id: string): Promise<void> {
  await hubRequest<{ ok: boolean }>(`/api/hub/templates/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/**
 * Write a template onto one or more hosts.
 *
 * The `secrets` in `body` exist only for the duration of this call: they are
 * in the request the Hub spends on one outbound write each and are in no
 * column of its database (see `SecretHole`), so the caller clears its own copy
 * as soon as this resolves — on failure as much as on success.
 */
export async function instantiateHubTemplate(
  id: string,
  body: InstantiateHubTemplateRequest,
): Promise<ProvisioningResult[]> {
  const raw = await hubRequest<unknown>(
    `/api/hub/templates/${encodeURIComponent(id)}/instantiate`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  const parsed = InstantiateHubTemplateResponse.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError('The Hub answered something this app could not read.', 502, 'bad_response');
  }
  return parsed.data.results;
}

/**
 * The Hub's host registry, as the Hub itself spells it.
 *
 * Read here rather than taken from `useHostDirectory().hosts`, and the reason
 * is a correctness one rather than a preference: a `HostRecord`'s
 * `endpoint.id` is the *routing* id used in `#/h/<id>/...`, and for the Hub's
 * default host that is deliberately `DEFAULT_HOST_ID` — the bare-root mount —
 * not the registry id the Hub knows that machine by. `hostIds` in an
 * instantiate request is the registry id (`HubHostId`), so provisioning built
 * from a `HostRecord` would send `local` and the Hub would answer "no such
 * host" for the one machine most likely to be picked first.
 *
 * It also carries `enabled` and the Hub's own health verdict, which is what
 * the host picker needs to say why a host is not a good target.
 */
export async function listHubHosts(): Promise<HubHostEntry[]> {
  const body = await hubRequest<unknown>('/api/hub/hosts');
  const parsed = HubHostListResponse.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('This origin is not a PocketAgent Hub.', 404, 'not_a_hub');
  }
  return parsed.data.hosts;
}

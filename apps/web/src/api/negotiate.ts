import {
  HealthResponse,
  PROTOCOL_VERSION,
  describeIncompatibility,
  negotiateProtocol,
  type HostCompatibility,
} from '@pocketagent/protocol';
import { hostUrl, type HostEndpoint } from './host.js';

/**
 * Asks one host whether this bundle can talk to it (PA-61).
 *
 * ## Why this is not part of `createApiClient`
 *
 * Every other method there throws `ApiError` on failure, which is right for a
 * call a human just triggered — but the whole point of a probe is that failure
 * is an expected, per-host *state*, not an exception to surface. A host being
 * down or too old has to end up as one greyed row while every other host stays
 * fully usable, so this returns a verdict rather than throwing.
 *
 * ## Why it re-parses the response
 *
 * `HealthResponse` is validated here rather than trusted, because this is the
 * one response that may come from a *different* build than the one that
 * produced this bundle — that is the premise of the whole ticket. A host so old
 * that it predates `protocol` on `/health` answers with a shape this schema
 * rejects, and the honest verdict for it is the same as for a host that did not
 * answer: unreachable, meaning "cannot be negotiated with", not "understood and
 * found wanting".
 */
export async function probeHost(
  endpoint: HostEndpoint,
  fetchImpl: typeof fetch = fetch,
): Promise<HostCompatibility> {
  try {
    const response = await fetchImpl(hostUrl(endpoint, '/health'), {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return negotiateProtocol(PROTOCOL_VERSION, null);
    const parsed = HealthResponse.safeParse(await response.json());
    if (!parsed.success) return negotiateProtocol(PROTOCOL_VERSION, null);
    return negotiateProtocol(PROTOCOL_VERSION, parsed.data.protocol);
  } catch {
    // A network error, a DNS failure, an aborted request, a body that is not
    // JSON: all indistinguishable from here, and all mean the same thing to a
    // human looking at the host list.
    return negotiateProtocol(PROTOCOL_VERSION, null);
  }
}

/**
 * Everything the UI needs to render one host's compatibility.
 *
 * Carries the host's *name* alongside the verdict because the sentence has to
 * say which machine it is about — with several hosts, "incompatible" on its own
 * is unactionable.
 */
export interface HostCompatibilityState {
  readonly compatibility: HostCompatibility;
  /** Null until the probe resolves, so the UI can avoid flashing a warning. */
  readonly message: string | null;
}

/** Pairs a verdict with the sentence for it, or null when the host is fine. */
export function compatibilityState(
  hostName: string,
  compatibility: HostCompatibility,
): HostCompatibilityState {
  return { compatibility, message: describeIncompatibility(hostName, compatibility) };
}

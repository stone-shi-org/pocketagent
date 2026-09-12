import { useCallback, useEffect, useState } from 'react';
import type { AgentInfo } from '@pocketagent/protocol';
import { isCustomClaudeProviderId } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';

interface Props {
  onApiError: (error: unknown) => void;
}

/**
 * PA-50 (reporter: "New chat should be able to pick model and effort for
 * other coding agents too ... also proactively probe every CLI at server
 * startup [and] a new Settings section with agent status + a Refresh
 * button" — the startup-probe half was explicitly dropped; this is the
 * manual half). One row per coding agent — filters `GET /api/agents`'s full
 * list down to adapters that support the `structured` transport and are
 * not a `custom-claude:*` variant, the same filter
 * `SessionManager.refreshAgentCatalogs` uses server-side, so this section's
 * rows are exactly the set the button below actually touches. A variant is
 * excluded on purpose: it already has its own management page
 * (`CustomClaudeProvidersSection`) and always reports a fixed
 * `staticModels` catalog rather than discovering one, so "refresh" has
 * nothing to do for it.
 *
 * Modeled on `SkillsSection`'s shape (one section-level "Refresh" button,
 * one busy flag, replace-the-list-wholesale on success) rather than
 * `McpRegistriesSection`'s per-row "Test connection" — there is nothing here
 * for a *row* to trigger individually; refreshing one agent still means one
 * request to that agent's own CLI/daemon, and batching all five behind one
 * button is simpler than five spinners for a page nobody watches live.
 *
 * No CLI version is shown, deliberately: no adapter here has a confirmed
 * `--version` invocation, and fabricating one would be exactly the kind of
 * unverified CLI assumption this codebase's adapters go out of their way
 * not to make (see e.g. `normalizeAgyModelList`'s doc comment on agy's own
 * `--effort` flag). Availability, cached model count, and the outcome of
 * the last explicit refresh are what is actually knowable without guessing.
 */
export function CodingAgentsSection({ onApiError }: Props): JSX.Element {
  const [agentsList, setAgentsList] = useState<AgentInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.listAgents();
      setAgentsList(res.agents);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load coding agents.');
    }
  }, [onApiError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh(): Promise<void> {
    setRefreshing(true);
    try {
      const res = await api.refreshAgents();
      setAgentsList(res.agents);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not refresh coding agents.');
    } finally {
      setRefreshing(false);
    }
  }

  const codingAgents = (agentsList ?? []).filter(
    (a) => a.transports.includes('structured') && !isCustomClaudeProviderId(a.id),
  );

  return (
    <>
      <p className="transport-hint" style={{ marginBottom: 10 }}>
        The model catalog each agent's own CLI last reported — passively, whenever a session of
        that agent ran, or explicitly from "Refresh" below, which asks each one directly without
        starting a real session or counting against the session limit.
      </p>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {agentsList === null ? (
        <div className="spinner">Loading…</div>
      ) : (
        codingAgents.map((a) => (
          <div key={a.id} className="planner-model-row">
            <span>
              <strong>{a.displayName}</strong>{' '}
              {!a.available && <span className="settings-badge">Not on PATH</span>}
              <br />
              <span className="planner-row-meta">
                {a.cachedModels.length > 0
                  ? `${a.cachedModels.length} model(s) known`
                  : 'No models known yet'}
              </span>
              <br />
              <span className="planner-row-meta">
                {a.lastRefreshAt === null
                  ? 'Never explicitly refreshed'
                  : a.lastRefreshOk
                    ? `Last refreshed ${new Date(a.lastRefreshAt).toLocaleString()}`
                    : `Refresh failed ${new Date(a.lastRefreshAt).toLocaleString()} — ${a.lastRefreshError ?? 'unknown error'}`}
              </span>
            </span>
          </div>
        ))
      )}

      <div className="planner-inline" style={{ marginTop: 12 }}>
        <button type="button" className="planner-btn" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </>
  );
}

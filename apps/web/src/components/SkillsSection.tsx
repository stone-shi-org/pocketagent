import { useCallback, useEffect, useState } from 'react';
import type { PlannerSkillInfo } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { Icon } from './Icon.js';
import { PlannerDirectoryPicker } from './PlannerDirectoryPicker.js';

interface Props {
  onApiError: (error: unknown) => void;
  /** Called after a successful register/delete/refresh/toggle, so the
      parent's own "Tools" section (skills are otherwise independent of it,
      but both live on the same settings page) can stay in step — mirrors
      `McpRegistriesSection`'s identical prop. */
  onChanged: () => void;
}

/**
 * PA-38: manage global skills — reusable instructions (`SKILL.md`, a
 * directory of YAML frontmatter plus a Markdown body) any agent can load
 * with `use_skill`. Modeled directly on `McpRegistriesSection`, stripped of
 * everything that exists there only because a remote MCP server needs a
 * connection: no auth, no "Test connection" — a skill is inert content read
 * straight off disk, so "register" here means "point at a directory that
 * already has a valid SKILL.md," not "configure a live target."
 *
 * A per-workspace skill (an agent's own `.skills/<slug>/SKILL.md`) has no
 * management UI here at all — it is invisible to this section by design,
 * the same "read-only" split "Projects" already draws between browsing and
 * managing; deleting one is a file operation within that agent's own
 * workspace, not a global catalog action.
 */
export function SkillsSection({ onApiError, onChanged }: Props): JSX.Element {
  const [skills, setSkills] = useState<PlannerSkillInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<PlannerSkillInfo | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.listPlannerSkills();
      setSkills(res.skills);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load skills.');
    }
  }, [onApiError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh(): Promise<void> {
    setBusy(true);
    try {
      const res = await api.refreshPlannerSkills();
      setSkills(res.skills);
      setError(null);
      onChanged();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not refresh skills.');
    } finally {
      setBusy(false);
    }
  }

  async function register(): Promise<void> {
    if (!pendingPath) return;
    setBusy(true);
    try {
      await api.registerPlannerSkill({ path: pendingPath });
      setPendingPath(null);
      await load();
      onChanged();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not register that skill.');
    } finally {
      setBusy(false);
    }
  }

  async function toggle(skill: PlannerSkillInfo, enabled: boolean): Promise<void> {
    setBusy(true);
    try {
      const res = await api.setPlannerSkillEnabledGlobally(skill.id, { enabled });
      setSkills(res.skills);
      onChanged();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not update that skill.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(skill: PlannerSkillInfo): Promise<void> {
    setBusy(true);
    try {
      await api.deletePlannerSkill(skill.id);
      setConfirmingDelete(null);
      await load();
      onChanged();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not delete that skill.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="transport-hint" style={{ marginBottom: 10 }}>
        Reusable instructions any agent can load with <code>use_skill</code> — a directory
        containing a <code>SKILL.md</code> (a name, a description, and a Markdown body of
        instructions). Loading one only adds text to the conversation; the model then acts using
        its own, already-gated tools. An agent's own <code>.skills/</code> directory adds skills
        just for that agent, managed from its own editor page instead of here.
      </p>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {skills === null ? (
        <div className="spinner">Loading…</div>
      ) : skills.length === 0 ? (
        <p className="planner-row-meta">No global skills yet.</p>
      ) : (
        skills.map((s) => (
          <label key={s.id} className="planner-checkbox-row" style={{ marginBottom: 6 }}>
            <input
              type="checkbox"
              checked={s.enabled}
              disabled={busy}
              onChange={(e) => void toggle(s, e.target.checked)}
            />
            <span>
              <strong>{s.name}</strong> <code className="planner-row-meta">{s.slug}</code>
              <br />
              <span className="planner-row-meta">{s.description}</span>
            </span>
            <div className="planner-row-actions">
              <button
                type="button"
                className="planner-btn danger"
                disabled={busy}
                onClick={() => setConfirmingDelete(s)}
                aria-label={`Delete ${s.name}`}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          </label>
        ))
      )}

      <div className="planner-inline" style={{ marginTop: 12, flexWrap: 'wrap' }}>
        <button type="button" className="planner-btn" disabled={busy} onClick={() => setShowPicker(true)}>
          Add skill
        </button>
        <button type="button" className="planner-btn" disabled={busy} onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {pendingPath && (
        <p className="planner-row-meta" style={{ marginTop: 6 }}>
          Directory: <code title={pendingPath}>{pendingPath}</code> —{' '}
          <button type="button" className="planner-link-btn" disabled={busy} onClick={() => void register()}>
            Register
          </button>{' '}
          <button type="button" className="planner-link-btn" disabled={busy} onClick={() => setPendingPath(null)}>
            Cancel
          </button>
        </p>
      )}

      {showPicker && (
        <PlannerDirectoryPicker
          onClose={() => setShowPicker(false)}
          onPick={(path) => {
            setPendingPath(path);
            setShowPicker(false);
          }}
          onApiError={onApiError}
        />
      )}

      {confirmingDelete && (
        <ConfirmDialog
          title={`Delete ${confirmingDelete.name}?`}
          body="Removes its directory from the skills root entirely — this cannot be undone. Any per-agent or global enable/disable decisions recorded for it are cleaned up too."
          confirmLabel="Delete"
          busy={busy}
          onConfirm={() => void remove(confirmingDelete)}
          onCancel={() => setConfirmingDelete(null)}
        />
      )}
    </>
  );
}

import { useEffect, useMemo, useState } from 'react';
import type { ExportPlannerSkillResponse, SkillExportTarget } from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { useHostApi } from '../hosts/HostContext.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import {
  DEFAULT_EXPORT_TARGETS,
  EXPORT_TARGET_LABELS,
  exportDestinations,
  previewExportPath,
  type ExportDestination,
} from '../agent/skill-export.js';

interface Props {
  skill: { id: string; name: string; slug: string };
  onApiError: (error: unknown) => void;
  onClose: () => void;
}

const OTHER = '__other__';

/**
 * PA-55: copy one Pocket Agent skill into a project so a coding-agent session
 * working there (`claude`, `codex`, …) can load it. One skill at a time, and
 * only from here: no planner tool and no MCP tool can do this, so the click
 * is the approval. The dialog therefore shows the exact paths it will write
 * before anything is written, and says the files land as untracked changes.
 * A collision is never overwritten silently. The server answers 409 with
 * nothing written, and a separate confirmation retries with `overwrite`.
 */
export function SkillExportDialog({ skill, onApiError, onClose }: Props): JSX.Element {
  const api = useHostApi();
  const [destinations, setDestinations] = useState<ExportDestination[] | null>(null);
  const [choice, setChoice] = useState<string>('');
  const [otherPath, setOtherPath] = useState('');
  const [targets, setTargets] = useState<SkillExportTarget[]>([...DEFAULT_EXPORT_TARGETS]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [done, setDone] = useState<ExportPlannerSkillResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listProjects()
      .then((res) => {
        if (cancelled) return;
        const list = exportDestinations(res.projects);
        setDestinations(list);
        setChoice(list[0]?.cwd ?? OTHER);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        onApiError(err);
        setDestinations([]);
        setChoice(OTHER);
      });
    return () => {
      cancelled = true;
    };
  }, [api, onApiError]);

  const projectPath = choice === OTHER ? otherPath.trim() : choice;
  const previews = useMemo(
    () => (projectPath ? targets.map((t) => previewExportPath(projectPath, t, skill.slug)) : []),
    [projectPath, targets, skill.slug],
  );

  function toggleTarget(target: SkillExportTarget, on: boolean): void {
    setTargets((prev) => {
      const next = on ? [...new Set([...prev, target])] : prev.filter((t) => t !== target);
      // Keep the table's order, so the preview and the request read the same way.
      return DEFAULT_EXPORT_TARGETS.filter((t) => next.includes(t));
    });
  }

  async function submit(overwrite: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await api.exportPlannerSkill(skill.id, { projectPath, targets, overwrite });
      setConflict(null);
      setDone(res);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflict(err.message);
      } else if (err instanceof ApiError && !err.isUnauthorized) {
        setError(err.message);
      } else {
        onApiError(err);
      }
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = !busy && projectPath.length > 0 && targets.length > 0;

  return (
    <>
      <div
        className="dialog-backdrop"
        onClick={busy || conflict ? undefined : onClose}
        role="presentation"
      >
        <div
          className="dialog"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label={`Export ${skill.name} to a project`}
        >
          <h2>Export “{skill.name}” to a project</h2>

          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}

          {done ? (
            <>
              <p className="confirm-body">
                Exported. A coding-agent session working in this project can now load it:
              </p>
              <ul className="planner-row-meta">
                {done.results.map((r) => (
                  <li key={r.target}>
                    <code>{r.path}</code>
                    {r.overwrote ? ' (replaced)' : ''}
                  </li>
                ))}
              </ul>
              <p className="transport-hint">
                These are untracked changes in the repository. Review and commit them yourself.
              </p>
              {done.busy && (
                <p className="transport-hint">
                  A session is mid-turn in this working tree. It picks the skill up the next time it
                  looks for skills, not in the turn it is running now.
                </p>
              )}
              <div className="dialog-actions">
                <button type="button" className="primary" onClick={onClose}>
                  Done
                </button>
              </div>
            </>
          ) : (
            <>
              <label className="field">
                <span>Project</span>
                {destinations === null ? (
                  <div className="spinner">Loading…</div>
                ) : (
                  <select
                    value={choice}
                    disabled={busy}
                    onChange={(e) => setChoice(e.target.value)}
                  >
                    {destinations.map((d) => (
                      <option key={d.cwd} value={d.cwd}>
                        {d.label}
                      </option>
                    ))}
                    <option value={OTHER}>Another directory inside a project folder…</option>
                  </select>
                )}
              </label>
              {choice === OTHER && (
                <label className="field">
                  <span>Directory</span>
                  <input
                    type="text"
                    value={otherPath}
                    disabled={busy}
                    placeholder="/path/inside/a/project/folder"
                    onChange={(e) => setOtherPath(e.target.value)}
                  />
                </label>
              )}

              <fieldset style={{ border: 'none', padding: 0, margin: '0 0 14px', display: 'grid', gap: 6 }}>
                <span>Skill directories</span>
                {DEFAULT_EXPORT_TARGETS.map((t) => (
                  <label key={t} className="planner-checkbox-row">
                    <input
                      type="checkbox"
                      checked={targets.includes(t)}
                      disabled={busy}
                      onChange={(e) => toggleTarget(t, e.target.checked)}
                    />
                    <span>{EXPORT_TARGET_LABELS[t]}</span>
                  </label>
                ))}
              </fieldset>

              {previews.length > 0 && (
                <>
                  <p className="planner-row-meta" style={{ marginBottom: 4 }}>
                    Will write:
                  </p>
                  <ul className="planner-row-meta" style={{ marginTop: 0 }}>
                    {previews.map((p) => (
                      <li key={p}>
                        <code>{p}</code>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <p className="transport-hint">
                This copies the skill’s folder into the repository as untracked files. Nothing is
                committed, and later edits to the Pocket Agent’s copy are not synced.
              </p>

              <div className="dialog-actions">
                <button type="button" onClick={onClose} disabled={busy}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={!canSubmit}
                  onClick={() => void submit(false)}
                >
                  {busy ? 'Exporting…' : 'Export'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* A sibling rather than a child: a click on its backdrop must not
          bubble into this dialog's own close handler. */}
      {conflict && (
        <ConfirmDialog
          title="Replace the existing skill?"
          body={`${conflict} Replacing it deletes every file in that skill's folder and writes this skill in its place.`}
          confirmLabel="Replace"
          busy={busy}
          onConfirm={() => void submit(true)}
          onCancel={() => setConflict(null)}
        />
      )}
    </>
  );
}

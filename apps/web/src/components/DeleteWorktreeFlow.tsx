import { useState } from 'react';
import type { ProjectInfo } from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { ConfirmDialog } from './ConfirmDialog.js';

/** The subset of `ProjectsState` this flow needs — kept narrow so it's easy to test in isolation. */
export interface DeleteWorktreeFlowState {
  deleteWorktree: (cwd: string) => Promise<{
    branch: string;
    mainCwd: string;
    remote: { remoteName: string; remoteBranch: string } | null;
  }>;
  deleteRemoteBranch: (body: { cwd: string; remoteName: string; remoteBranch: string }) => Promise<void>;
  refresh: () => Promise<void>;
}

interface Props {
  /** The worktree row this menu action was opened from. */
  project: ProjectInfo;
  state: DeleteWorktreeFlowState;
  onApiError: (error: unknown) => void;
  onClose: () => void;
}

export type AskRemoteStep = { kind: 'ask-remote'; mainCwd: string; remoteName: string; remoteBranch: string };

type Step =
  | { kind: 'confirm' }
  | { kind: 'deleting' }
  /** `message` is the server's own rejection text — it already names the branch and, for
   *  `unmerged`, the exact merge target, so there is nothing to duplicate client-side. */
  | { kind: 'blocked-error'; message: string }
  | AskRemoteStep
  | { kind: 'deleting-remote'; mainCwd: string; remoteName: string; remoteBranch: string };

/**
 * `deleteWorktree` rejections the browser knows how to explain: expected,
 * actionable outcomes the server itself already produces a clear message
 * for, as opposed to a genuinely unexpected failure that belongs in the
 * project list's generic error banner instead.
 */
export const BLOCKING_DELETE_ERROR_CODES = new Set(['dirty', 'unmerged', 'worktree_busy']);

/**
 * Whether a `deleteWorktree` rejection is one of the three expected ones this
 * flow shows as an informational dialog, pulled out as a pure predicate so
 * the branching logic is unit-testable without rendering anything.
 */
export function isBlockingDeleteError(err: unknown): err is ApiError {
  return err instanceof ApiError && BLOCKING_DELETE_ERROR_CODES.has(err.code);
}

/**
 * What comes next after a successful `deleteWorktree` call: a follow-up
 * asking about the remote branch, or `null` if there is nothing left to ask
 * (the worktree had no remote-tracking branch) and the flow should just close.
 */
export function stepAfterWorktreeDeleted(result: {
  mainCwd: string;
  remote: { remoteName: string; remoteBranch: string } | null;
}): AskRemoteStep | null {
  if (!result.remote) return null;
  return { kind: 'ask-remote', mainCwd: result.mainCwd, ...result.remote };
}

/**
 * The three-dot menu's "Delete worktree…" action, as a small state machine
 * driving `ConfirmDialog` through however many steps this particular
 * deletion needs: a plain confirm; an informational dead-end if the server
 * refuses (uncommitted changes, an unmerged branch, or a live session in it);
 * or, on success, a follow-up asking whether to also delete the branch's
 * remote counterpart.
 *
 * Deliberately does its own error handling rather than routing through
 * `onApiError`/the project list's generic error banner for the three
 * *expected* rejections (`dirty`, `unmerged`, `worktree_busy`) — those are
 * actionable, not surprising, and deserve the same dialog treatment as the
 * confirm step itself. Anything else falls back to the generic banner.
 */
export function DeleteWorktreeFlow({ project, state, onApiError, onClose }: Props): JSX.Element {
  const [step, setStep] = useState<Step>({ kind: 'confirm' });

  const branch = project.gitBranch ?? project.name;

  const close = (): void => {
    onClose();
    void state.refresh();
  };

  const runDelete = (): void => {
    setStep({ kind: 'deleting' });
    state.deleteWorktree(project.cwd).then(
      (result) => {
        const next = stepAfterWorktreeDeleted(result);
        if (next) setStep(next);
        else close();
      },
      (err: unknown) => {
        if (isBlockingDeleteError(err)) {
          setStep({ kind: 'blocked-error', message: err.message });
          return;
        }
        onApiError(err);
        close();
      },
    );
  };

  const runDeleteRemote = (mainCwd: string, remoteName: string, remoteBranch: string): void => {
    setStep({ kind: 'deleting-remote', mainCwd, remoteName, remoteBranch });
    state.deleteRemoteBranch({ cwd: mainCwd, remoteName, remoteBranch }).then(
      () => close(),
      (err: unknown) => {
        // The worktree and local branch are already gone either way — this
        // is only "did the remote cleanup also happen", never ambiguity
        // about whether the delete itself succeeded.
        onApiError(err);
        close();
      },
    );
  };

  switch (step.kind) {
    case 'confirm':
    case 'deleting':
      return (
        <ConfirmDialog
          title="Delete worktree"
          body={`Delete "${branch}" and its worktree? This removes the .worktrees/ directory and the local branch. This can't be undone.`}
          confirmLabel="Delete"
          danger
          busy={step.kind === 'deleting'}
          onConfirm={runDelete}
          onCancel={onClose}
        />
      );

    case 'blocked-error':
      return (
        <ConfirmDialog
          title="Can't delete this worktree"
          body={step.message}
          confirmLabel="OK"
          danger={false}
          hideCancel
          onConfirm={onClose}
          onCancel={onClose}
        />
      );

    case 'ask-remote':
    case 'deleting-remote':
      return (
        <ConfirmDialog
          title="Delete remote branch too?"
          body={`The branch had a remote at ${step.remoteName}/${step.remoteBranch}. Delete it there too?`}
          confirmLabel="Delete remote branch"
          cancelLabel="Not now"
          danger
          busy={step.kind === 'deleting-remote'}
          onConfirm={() => runDeleteRemote(step.mainCwd, step.remoteName, step.remoteBranch)}
          onCancel={close}
        />
      );
  }
}

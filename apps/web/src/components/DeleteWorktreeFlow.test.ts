import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.js';
import { isBlockingDeleteError, stepAfterWorktreeDeleted } from './DeleteWorktreeFlow.js';

/**
 * `DeleteWorktreeFlow` itself is a small React state machine, but the two
 * decisions that matter — "does this rejection get its own dialog, or the
 * generic error banner?" and "is there a follow-up to ask about?" — are pure
 * functions extracted specifically so they're testable here. The `web`
 * vitest project has no jsdom/rendering setup (see `vitest.config.ts`'s
 * `environment: 'node'`, and every existing `apps/web/src/**` test is a
 * `.test.ts` covering plain logic pulled out of a component the same way),
 * so this is the level this codebase tests UI logic at rather than
 * introducing a new rendering harness for one component.
 */
describe('isBlockingDeleteError', () => {
  it.each(['dirty', 'unmerged', 'worktree_busy'])(
    'treats %s as a blocking, explainable rejection',
    (code) => {
      const err = new ApiError('rejected', 409, code);
      expect(isBlockingDeleteError(err)).toBe(true);
    },
  );

  it.each(['not_a_worktree', 'git_failed', 'forbidden'])(
    'does not treat %s as blocking — it belongs in the generic error banner',
    (code) => {
      const err = new ApiError('failed', 500, code);
      expect(isBlockingDeleteError(err)).toBe(false);
    },
  );

  it('does not treat a non-ApiError as blocking', () => {
    expect(isBlockingDeleteError(new Error('boom'))).toBe(false);
    expect(isBlockingDeleteError('boom')).toBe(false);
    expect(isBlockingDeleteError(undefined)).toBe(false);
  });
});

describe('stepAfterWorktreeDeleted', () => {
  it('returns null (close the flow) when the branch had no remote', () => {
    expect(stepAfterWorktreeDeleted({ mainCwd: '/repo', remote: null })).toBeNull();
  });

  it('returns an ask-remote step carrying exactly what the server reported', () => {
    const step = stepAfterWorktreeDeleted({
      mainCwd: '/repo',
      remote: { remoteName: 'origin', remoteBranch: 'feature/x' },
    });
    expect(step).toEqual({
      kind: 'ask-remote',
      mainCwd: '/repo',
      remoteName: 'origin',
      remoteBranch: 'feature/x',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.js';
import {
  extractTmuxSessionName,
  isMissingAdoptTargetError,
} from './RecreateShellDialog.js';

describe('extractTmuxSessionName', () => {
  it('prefers explicit adoptSessionName when present', () => {
    expect(
      extractTmuxSessionName({
        adoptSessionName: 'feature-infra',
        title: 'zsh · other-title',
      }),
    ).toBe('feature-infra');
  });

  it('parses tmux session name from composite title format', () => {
    expect(
      extractTmuxSessionName({
        adoptSessionName: null,
        title: 'zsh · dev-server',
      }),
    ).toBe('dev-server');
  });

  it('handles titles with multiple dots correctly', () => {
    expect(
      extractTmuxSessionName({
        adoptSessionName: null,
        title: 'nvim · project · v2',
      }),
    ).toBe('project · v2');
  });

  it('falls back to full title when no delimiter exists', () => {
    expect(
      extractTmuxSessionName({
        adoptSessionName: null,
        title: 'my-custom-session',
      }),
    ).toBe('my-custom-session');
  });

  it('handles whitespace trimming properly', () => {
    expect(
      extractTmuxSessionName({
        adoptSessionName: '  spaced-session  ',
        title: 'zsh · fallback',
      }),
    ).toBe('spaced-session');
  });
});

describe('isMissingAdoptTargetError', () => {
  it('detects 404 status as missing target', () => {
    const err = new ApiError('Not found', 404, 'not_found');
    expect(isMissingAdoptTargetError(err)).toBe(true);
  });

  it('detects not_found error code regardless of status', () => {
    const err = new ApiError('Pane gone', 400, 'not_found');
    expect(isMissingAdoptTargetError(err)).toBe(true);
  });

  it('rejects other ApiError codes', () => {
    const err = new ApiError('Forbidden', 403, 'forbidden');
    expect(isMissingAdoptTargetError(err)).toBe(false);
  });

  it('rejects standard non-ApiError errors', () => {
    expect(isMissingAdoptTargetError(new Error('not found'))).toBe(false);
    expect(isMissingAdoptTargetError('not found')).toBe(false);
    expect(isMissingAdoptTargetError(null)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { LIMITS, displayNameForLandedPath, parseAttachedFileNotes } from '@pocketagent/protocol';
import {
  fileAttachProblem,
  filesBlockSend,
  filesFromDataTransfer,
  formatFileSize,
  readyAttachmentIds,
  routeAttachment,
  type PendingFile,
} from './file-attachment.js';

describe('routeAttachment', () => {
  const files = { hasInlineImage: false, supportsFiles: true };

  it('sends the first supported image inline, exactly as before', () => {
    expect(routeAttachment({ type: 'image/png' }, files)).toBe('inline-image');
    expect(routeAttachment({ type: 'image/webp' }, files)).toBe('inline-image');
  });

  it('uploads a second image as a file rather than replacing the first', () => {
    expect(routeAttachment({ type: 'image/png' }, { ...files, hasInlineImage: true })).toBe('file');
  });

  it('uploads everything else as a file', () => {
    for (const type of ['application/pdf', 'text/markdown', 'image/svg+xml', 'image/heic', '']) {
      expect(routeAttachment({ type }, files)).toBe('file');
    }
  });

  it('refuses a file where only images are supported', () => {
    expect(routeAttachment({ type: 'application/pdf' }, { hasInlineImage: false, supportsFiles: false })).toBeNull();
    expect(routeAttachment({ type: 'image/png' }, { hasInlineImage: false, supportsFiles: false })).toBe('inline-image');
  });
});

describe('fileAttachProblem', () => {
  it('names the file and the cap when it is too large', () => {
    expect(fileAttachProblem({ name: 'big.pdf', size: LIMITS.maxAttachmentBytes + 1 }, 0)).toMatch(/big\.pdf.*20 MB/);
    expect(fileAttachProblem({ name: 'ok.pdf', size: LIMITS.maxAttachmentBytes }, 0)).toBeNull();
  });

  it('refuses a sixth file', () => {
    expect(fileAttachProblem({ name: 'x', size: 1 }, LIMITS.maxAttachmentsPerPrompt)).toMatch(/At most 5/);
  });
});

describe('send gating', () => {
  const file = (state: PendingFile['state'], attachmentId?: string): PendingFile => ({
    localId: Math.random().toString(36),
    name: 'f',
    size: 1,
    mediaType: 'text/plain',
    state,
    ...(attachmentId ? { attachmentId } : {}),
  });

  it('sends only ready ids, in order', () => {
    expect(readyAttachmentIds([file('ready', 'att_a'), file('uploading'), file('ready', 'att_b')])).toEqual(['att_a', 'att_b']);
  });

  it('blocks while uploading, and while a failed chip is still there', () => {
    expect(filesBlockSend([file('ready', 'att_a')])).toBeNull();
    expect(filesBlockSend([file('ready', 'att_a'), file('uploading')])).toBe('uploading');
    expect(filesBlockSend([file('error')])).toBe('error');
  });
});

describe('filesFromDataTransfer', () => {
  it('takes file items and ignores text ones', () => {
    const f = { name: 'a.pdf' } as File;
    const items = [
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => f },
    ];
    expect(filesFromDataTransfer({ items })).toEqual([f]);
    expect(filesFromDataTransfer({ items: [{ kind: 'string', getAsFile: () => null }] })).toEqual([]);
    expect(filesFromDataTransfer(null)).toEqual([]);
  });
});

describe('formatFileSize', () => {
  it('reads naturally', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2 KB');
    expect(formatFileSize(3.5 * 1024 * 1024)).toBe('3.5 MB');
  });
});

describe('the note a coding agent is sent, read back for a chip', () => {
  it('splits trailing note lines off the prompt', () => {
    const text = 'look at these\n\n[Attached file saved to: .pocketagent/attachments/a_20261012-143005_a1b2.pdf]\n[Attached file saved to: .pocketagent/attachments/b.md]';
    expect(parseAttachedFileNotes(text)).toEqual({
      text: 'look at these',
      paths: ['.pocketagent/attachments/a_20261012-143005_a1b2.pdf', '.pocketagent/attachments/b.md'],
    });
  });

  it('keeps an image note in the text, and leaves a mid-text mention alone', () => {
    const withImage = 'hi\n\n[Attached image saved to: .pocketagent/attachments/attachment_1_ab.png]\n[Attached file saved to: x.md]';
    expect(parseAttachedFileNotes(withImage).text).toBe('hi\n\n[Attached image saved to: .pocketagent/attachments/attachment_1_ab.png]');
    const quoted = 'what does [Attached file saved to: x] mean?';
    expect(parseAttachedFileNotes(quoted)).toEqual({ text: quoted, paths: [] });
  });

  it('takes a sidecar line with its file, and makes no chip of it (PA-137)', () => {
    const text =
      'read these\n\n[Attached file saved to: .pocketagent/attachments/r_x.pdf]\n' +
      '[Extracted text saved to: .pocketagent/attachments/r_x.pdf.txt (truncated)]\n' +
      '[Attached file saved to: .pocketagent/attachments/n.md]';
    expect(parseAttachedFileNotes(text)).toEqual({
      text: 'read these',
      paths: ['.pocketagent/attachments/r_x.pdf', '.pocketagent/attachments/n.md'],
    });
    // A prompt that merely ends with such a line, with no file note above it, keeps it.
    const lone = 'what is\n[Extracted text saved to: x.txt]';
    expect(parseAttachedFileNotes(lone)).toEqual({ text: lone, paths: [] });
  });

  it('a file-only prompt has no text left', () => {
    expect(parseAttachedFileNotes('[Attached file saved to: a.md]')).toEqual({ text: '', paths: ['a.md'] });
  });

  it('names a landed file without the server suffix', () => {
    expect(displayNameForLandedPath('.pocketagent/attachments/Q3 report_20261012-143005_a1b2.pdf')).toBe('Q3 report.pdf');
    expect(displayNameForLandedPath('artifacts/uploads/README_20261012-143005_ffff')).toBe('README');
    expect(displayNameForLandedPath('plain.md')).toBe('plain.md');
  });
});

describe('userPromptView (the transcript reducer)', () => {
  it('uses a Pocket Agent event\'s metadata, leaving the typed text alone', async () => {
    const { userPromptView } = await import('./transcript.js');
    const view = userPromptView({
      text: 'summarise',
      attachments: [{ name: 'Spec.pdf', path: 'artifacts/uploads/Spec_20261012-143005_a1b2.pdf', size: 8, mediaType: 'application/pdf' }],
    });
    expect(view.text).toBe('summarise');
    expect(view.files).toEqual([{ name: 'Spec.pdf', path: 'artifacts/uploads/Spec_20261012-143005_a1b2.pdf', size: 8, mediaType: 'application/pdf' }]);
  });

  it('reads a coding agent\'s note lines back into chips, live or replayed alike', async () => {
    const { userPromptView } = await import('./transcript.js');
    const view = userPromptView({
      text: 'look\n\n[Attached file saved to: .pocketagent/attachments/notes_20261012-143005_a1b2.md]',
    });
    expect(view.text).toBe('look');
    expect(view.files).toEqual([{ name: 'notes.md', path: '.pocketagent/attachments/notes_20261012-143005_a1b2.md' }]);
  });

  it('finds the notes under a voice turn\'s spoken-summary instruction', async () => {
    const { userPromptView } = await import('./transcript.js');
    const { appendSpokenSummaryInstruction } = await import('@pocketagent/protocol');
    const text = appendSpokenSummaryInstruction('look\n\n[Attached file saved to: a.md]');
    expect(userPromptView({ text })).toEqual({ text: 'look', files: [{ name: 'a.md', path: 'a.md' }] });
  });
});

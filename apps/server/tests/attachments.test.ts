import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveAttachmentToWorkspace } from '../src/sessions/attachments.js';

describe('saveAttachmentToWorkspace', () => {
  it('saves a base64 image into .pocketagent/attachments inside the workspace', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-test-workspace-'));
    try {
      const image = {
        mediaType: 'image/png' as const,
        data: 'aGVsbG8=', // base64 "hello"
      };

      const relPath = saveAttachmentToWorkspace(cwd, image);
      expect(relPath).toMatch(/^\.pocketagent\/attachments\/attachment_\d+_[a-f0-9]+\.png$/);

      const fullPath = path.join(cwd, relPath);
      expect(fs.existsSync(fullPath)).toBe(true);
      expect(fs.readFileSync(fullPath, 'utf8')).toBe('hello');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

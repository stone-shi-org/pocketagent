import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { PromptImage } from '@pocketagent/protocol';

/**
 * Saves a prompt image attachment to the session's workspace directory
 * under `.pocketagent/attachments/`.
 * Returns the relative path from `cwd` (e.g. `.pocketagent/attachments/attachment_1786772000_a1b2c3.png`).
 */
export function saveAttachmentToWorkspace(cwd: string, image: PromptImage): string {
  const dir = path.join(cwd, '.pocketagent', 'attachments');
  fs.mkdirSync(dir, { recursive: true });

  const extMap: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
  };
  const ext = extMap[image.mediaType] ?? '.png';
  const filename = `attachment_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
  const fullPath = path.join(dir, filename);

  const buffer = Buffer.from(image.data, 'base64');
  fs.writeFileSync(fullPath, buffer);

  const rel = path.relative(cwd, fullPath);
  return rel && !rel.startsWith('..') ? rel : fullPath;
}

#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const envPath = path.join(repoRoot, '.env');
const token = crypto.randomBytes(32).toString('base64url');

const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

if (/^POCKETAGENT_AUTH_TOKEN=.+$/m.test(existing)) {
  process.stdout.write(
    `.env already defines POCKETAGENT_AUTH_TOKEN — refusing to overwrite it.\n` +
      `If you want to rotate it, edit ${envPath} by hand and use:\n\n  ${token}\n\n` +
      `Rotating invalidates nothing automatically; existing browser cookies keep working\n` +
      `until they expire. Delete the auth_sessions table to force re-login.\n`,
  );
  process.exit(1);
}

const line = `POCKETAGENT_AUTH_TOKEN=${token}\n`;
const next = existing.length === 0 || existing.endsWith('\n') ? existing + line : `${existing}\n${line}`;

fs.writeFileSync(envPath, next, { mode: 0o600 });
try {
  fs.chmodSync(envPath, 0o600);
} catch {
  /* best effort */
}

process.stdout.write(
  `Wrote a new access token to ${envPath} (mode 600).\n\n  ${token}\n\n` +
    `Use it to log in from the browser. Do not commit .env.\n`,
);

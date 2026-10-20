import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CodexTranscriptStore } from '../src/conversations/codex.js';

describe('CodexTranscriptStore', () => {
  describe('titleFor (PA-164)', () => {
    let codexDir: string;
    let sessionIndexPath: string;
    let stateDbPath: string;

    beforeEach(() => {
      codexDir = fs.mkdtempSync('/tmp/pa-codex-titles-');
      sessionIndexPath = path.join(codexDir, 'session_index.jsonl');
      stateDbPath = path.join(codexDir, 'state_5.sqlite');
    });

    afterEach(() => {
      fs.rmSync(codexDir, { recursive: true, force: true });
    });

    it('reads thread_name from session_index.jsonl and prefers the latest non-empty entry for a thread id', async () => {
      fs.writeFileSync(
        sessionIndexPath,
        [
          JSON.stringify({
            id: '019fdf8c-116f-78a0-8fa3-a4e20a3b094d',
            thread_name: 'Say Hello',
            updated_at: '2026-08-08T04:05:31.228407703Z',
          }),
          JSON.stringify({
            id: '019fdf8d-f9dc-7b33-b62f-513f0ebe6647',
            thread_name: 'Initial Title',
            updated_at: '2026-08-08T04:07:00.000000000Z',
          }),
          'not valid json {',
          JSON.stringify({
            id: '019fdf8d-f9dc-7b33-b62f-513f0ebe6647',
            thread_name: '  Renamed Codex Thread  ',
            updated_at: '2026-08-08T04:07:35.894342184Z',
          }),
          JSON.stringify({
            id: 'blank-thread',
            thread_name: '   ',
            updated_at: '2026-08-08T04:08:00.000000000Z',
          }),
        ].join('\n') + '\n',
      );

      const store = new CodexTranscriptStore({ codexDir });

      expect(await store.titleFor('019fdf8c-116f-78a0-8fa3-a4e20a3b094d')).toBe('Say Hello');
      expect(await store.titleFor('019fdf8d-f9dc-7b33-b62f-513f0ebe6647')).toBe('Renamed Codex Thread');
      expect(await store.titleFor('blank-thread')).toBeNull();
      expect(await store.titleFor('unknown-id')).toBeNull();
    });

    it('falls back to read-only state_5.sqlite threads.title when session_index.jsonl is missing or has no matching thread_name', async () => {
      const db = new Database(stateDbPath);
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL DEFAULT 0
        );
      `);
      const insert = db.prepare('INSERT INTO threads (id, title, updated_at) VALUES (?, ?, ?)');
      insert.run('019fe257-232b-7df1-af4a-a3a6214ee736', 'review the code', 1786209404);
      insert.run('019fe267-ac5b-7b73-846d-1738d0ac3b8c', '  commit and push  ', 1786209966);
      insert.run('blank-in-index', 'Title From SQLite', 1786210000);
      insert.run('blank-in-db', '   ', 1786210001);
      db.close();

      // An entry in session_index.jsonl with a blank thread_name falls back to state_5.sqlite.
      fs.writeFileSync(
        sessionIndexPath,
        JSON.stringify({
          id: 'blank-in-index',
          thread_name: '   ',
          updated_at: '2026-08-08T05:00:00Z',
        }) + '\n',
      );

      const store = new CodexTranscriptStore({ codexDir });

      expect(await store.titleFor('019fe257-232b-7df1-af4a-a3a6214ee736')).toBe('review the code');
      expect(await store.titleFor('019fe267-ac5b-7b73-846d-1738d0ac3b8c')).toBe('commit and push');
      expect(await store.titleFor('blank-in-index')).toBe('Title From SQLite');
      expect(await store.titleFor('blank-in-db')).toBeNull();
      expect(await store.titleFor('missing-everywhere')).toBeNull();
    });

    it('returns null without throwing when both session_index.jsonl and state_5.sqlite are missing or invalid', async () => {
      const store = new CodexTranscriptStore({ codexDir });
      expect(await store.titleFor('does-not-exist')).toBeNull();
      expect(await store.titleFor('')).toBeNull();
      expect(await store.titleFor('..')).toBeNull();
      expect(await store.titleFor('a/b')).toBeNull();
      expect(await store.titleFor('a\\b')).toBeNull();

      fs.writeFileSync(stateDbPath, 'not a valid sqlite database header');
      await expect(store.titleFor('any-id')).resolves.toBeNull();
    });
  });
});

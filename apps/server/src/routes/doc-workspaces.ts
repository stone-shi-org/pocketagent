import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  CreateDocWorkspaceRequest,
  DocFileMkdirRequest,
  DocFileRenameRequest,
  DocRestoreVersionRequest,
  DocTrashRestoreRequest,
  LIMITS,
  UpdateDocWorkspaceRequest,
  type DocFilePreviewResponse,
  type DocWorkspaceFilesResponse,
  type DocWorkspaceListResponse,
} from '@pocketagent/protocol';
import {
  DocVersionConflictError,
  DocWorkspaceNotFoundError,
  DocWorkspaceValidationError,
} from '../doc-workspaces/index.js';
import { ARTIFACT_CSP, PDF_PREVIEW_CSP } from '../security-headers.js';
import { auditConfigChange } from './shared.js';

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: { code: 'bad_request', message } });
}

function notFound(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(404).send({ error: { code: 'not_found', message } });
}

function conflict(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(409).send({ error: { code: 'version_conflict', message } });
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store');
}

function mapDocWorkspaceError(reply: FastifyReply, err: unknown): FastifyReply | never {
  if (err instanceof DocWorkspaceNotFoundError) {
    return notFound(reply, err.message);
  }
  if (err instanceof DocVersionConflictError) {
    return conflict(reply, err.message);
  }
  if (err instanceof DocWorkspaceValidationError) {
    return badRequest(reply, err.message);
  }
  throw err;
}

function mimeTypeForFile(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.pdf':
      return 'application/pdf';
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8';
    case '.md':
    case '.markdown':
      return 'text/markdown; charset=utf-8';
    case '.txt':
    case '.log':
      return 'text/plain; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.csv':
      return 'text/csv; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    case '.webp':
      return 'image/webp';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    default:
      return 'application/octet-stream';
  }
}

export const docWorkspaceRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/doc-workspaces', async (_request, reply) => {
    const response: DocWorkspaceListResponse = {
      workspaces: app.pocket.docWorkspaces.list(),
    };
    return noStore(reply).send(response);
  });

  app.post('/api/doc-workspaces', async (request, reply) => {
    const parsed = CreateDocWorkspaceRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    try {
      const ws = app.pocket.docWorkspaces.create(parsed.data, request.log);
      auditConfigChange(request, 'document workspace created', {
        workspace: ws.id,
        name: ws.name,
        path: ws.path,
        created: !!parsed.data.createPath,
      });
      return reply.code(201).send(ws);
    } catch (err) {
      return mapDocWorkspaceError(reply, err);
    }
  });

  app.get('/api/doc-workspaces/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const ws = app.pocket.docWorkspaces.get(id);
    if (!ws) return notFound(reply, 'Document workspace not found.');
    return noStore(reply).send(ws);
  });

  app.patch('/api/doc-workspaces/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UpdateDocWorkspaceRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    try {
      const ws = app.pocket.docWorkspaces.update(id, parsed.data, request.log);
      auditConfigChange(request, 'document workspace updated', {
        workspace: ws.id,
        fields: Object.keys(parsed.data),
      });
      return noStore(reply).send(ws);
    } catch (err) {
      return mapDocWorkspaceError(reply, err);
    }
  });

  app.delete('/api/doc-workspaces/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = app.pocket.docWorkspaces.get(id);
    if (!existing) return notFound(reply, 'Document workspace not found.');
    app.pocket.docWorkspaces.delete(id);
    auditConfigChange(request, 'document workspace removed', {
      workspace: id,
      name: existing.name,
      path: existing.path,
    });
    return reply.code(204).send();
  });

  app.get('/api/doc-workspaces/:id/files', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const response: DocWorkspaceFilesResponse = app.pocket.docWorkspaces.listFiles(id);
      return noStore(reply).send(response);
    } catch (err) {
      return mapDocWorkspaceError(reply, err);
    }
  });

  app.post('/api/doc-workspaces/:id/files/mkdir', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = DocFileMkdirRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    try {
      const result = app.pocket.docWorkspaces.mkdir(id, parsed.data.path);
      return noStore(reply).code(201).send({ ok: true, path: result.path });
    } catch (err) {
      return mapDocWorkspaceError(reply, err);
    }
  });

  app.post('/api/doc-workspaces/:id/files/rename', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = DocFileRenameRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    try {
      const result = await app.pocket.docWorkspaces.rename(
        id,
        parsed.data.fromPath,
        parsed.data.toPath,
        { actor: 'user', baseVersion: parsed.data.baseVersion },
      );
      return noStore(reply).send({ ok: true, ...result });
    } catch (err) {
      return mapDocWorkspaceError(reply, err);
    }
  });

  app.delete('/api/doc-workspaces/:id/files', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { path?: string; baseVersion?: string };
    if (!query.path || !query.path.trim()) {
      return badRequest(reply, 'Missing required path query parameter.');
    }
    try {
      const result = await app.pocket.docWorkspaces.deleteFile(id, query.path, {
        actor: 'user',
        baseVersion: query.baseVersion,
      });
      return noStore(reply).send({ ok: true, path: result.path });
    } catch (err) {
      return mapDocWorkspaceError(reply, err);
    }
  });

  app.get('/api/doc-workspaces/:id/files/versions', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { path?: string };
    if (!query.path || !query.path.trim()) {
      return badRequest(reply, 'Missing required path query parameter.');
    }
    try {
      const response = app.pocket.docWorkspaces.listFileVersions(id, query.path);
      return noStore(reply).send(response);
    } catch (err) {
      return mapDocWorkspaceError(reply, err);
    }
  });

  app.get('/api/doc-workspaces/:id/versions/:versionId/download', async (request, reply) => {
    const { id, versionId } = request.params as { id: string; versionId: string };
    const query = request.query as { inline?: string; target?: string };
    try {
      const target = query.target === 'previous' ? 'previous' : 'version';
      const { blobPath, filename, size } = app.pocket.docWorkspaces.readVersionBlob(id, versionId, target);
      const mimeType = mimeTypeForFile(filename);
      const isInline = query.inline === '1' || query.inline === 'true';
      const disposition = isInline ? 'inline' : 'attachment';

      reply.header('Content-Type', mimeType);
      reply.header('Content-Length', size);
      reply.header('Content-Disposition', `${disposition}; filename="${encodeURIComponent(filename)}"`);
      if (isInline && mimeType === 'application/pdf') {
        reply.header('X-Frame-Options', 'SAMEORIGIN');
        reply.header('Content-Security-Policy', PDF_PREVIEW_CSP);
      } else {
        reply.header('Content-Security-Policy', ARTIFACT_CSP);
      }
      return reply.send(fs.createReadStream(blobPath));
    } catch (err) {
      return mapDocWorkspaceError(reply, err);
    }
  });

  app.get('/api/doc-workspaces/:id/versions/compare', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { before?: string; after?: string; from?: string; to?: string };
    const after = query.after ?? query.to;
    const before = query.before ?? query.from ?? null;
    if (!after) {
      return badRequest(reply, 'Missing required after (or to) query parameter.');
    }
    try {
      const response = await app.pocket.docWorkspaces.compareVersions(id, before, after);
      return noStore(reply).send(response);
    } catch (err) {
      return mapDocWorkspaceError(reply, err);
    }
  });

  app.post('/api/doc-workspaces/:id/versions/:versionId/restore', async (request, reply) => {
    const { id, versionId } = request.params as { id: string; versionId: string };
    const parsed = DocRestoreVersionRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    try {
      const response = await app.pocket.docWorkspaces.restoreVersion(id, versionId, {
        actor: 'user',
        target: parsed.data.target,
      });
      return noStore(reply).send(response);
    } catch (err) {
      return mapDocWorkspaceError(reply, err);
    }
  });

  app.get('/api/doc-workspaces/:id/trash', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const response = app.pocket.docWorkspaces.listTrash(id);
      return noStore(reply).send(response);
    } catch (err) {
      return mapDocWorkspaceError(reply, err);
    }
  });

  app.post('/api/doc-workspaces/:id/trash/:versionId/restore', async (request, reply) => {
    const { id, versionId } = request.params as { id: string; versionId: string };
    const parsed = DocTrashRestoreRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    try {
      const response = await app.pocket.docWorkspaces.restoreFromTrash(id, versionId, {
        actor: 'user',
        overwrite: parsed.data.overwrite,
      });
      return noStore(reply).send(response);
    } catch (err) {
      return mapDocWorkspaceError(reply, err);
    }
  });

  app.post('/api/doc-workspaces/:id/trash/restore', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = DocTrashRestoreRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    try {
      const response = await app.pocket.docWorkspaces.restoreFromTrash(id, {
        versionId: parsed.data.versionId,
        path: parsed.data.path,
        overwrite: parsed.data.overwrite,
        actor: 'user',
      });
      return noStore(reply).send(response);
    } catch (err) {
      return mapDocWorkspaceError(reply, err);
    }
  });

  app.get('/api/doc-workspaces/:id/files/preview', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { path?: string };
    if (!query.path || !query.path.trim()) {
      return badRequest(reply, 'Missing required path query parameter.');
    }
    try {
      const response: DocFilePreviewResponse = await app.pocket.docWorkspaces.previewFile(id, query.path);
      return noStore(reply).send(response);
    } catch (err) {
      return mapDocWorkspaceError(reply, err);
    }
  });

  app.get('/api/doc-workspaces/:id/files/download', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { path?: string; inline?: string };
    if (!query.path || !query.path.trim()) {
      return badRequest(reply, 'Missing required path query parameter.');
    }
    try {
      const { absPath, relPath } = app.pocket.docWorkspaces.resolveExistingPath(id, query.path);
      if (!relPath) return badRequest(reply, 'File path is required.');
      const stat = fs.lstatSync(absPath);
      if (!stat.isFile()) return badRequest(reply, 'Requested path is not a file.');

      const filename = path.basename(absPath);
      const mimeType = mimeTypeForFile(filename);
      const isInline = query.inline === '1' || query.inline === 'true';
      const disposition = isInline ? 'inline' : 'attachment';

      reply.header('Content-Type', mimeType);
      reply.header('Content-Length', stat.size);
      reply.header('Content-Disposition', `${disposition}; filename="${encodeURIComponent(filename)}"`);
      if (isInline && mimeType === 'application/pdf') {
        reply.header('X-Frame-Options', 'SAMEORIGIN');
        reply.header('Content-Security-Policy', PDF_PREVIEW_CSP);
      } else {
        reply.header('Content-Security-Policy', ARTIFACT_CSP);
      }

      return reply.send(fs.createReadStream(absPath));
    } catch (err) {
      return mapDocWorkspaceError(reply, err);
    }
  });

  app.get('/api/doc-workspaces/:id/files/zip', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { path?: string };
    try {
      const { filename, data } = app.pocket.docWorkspaces.buildZip(id, query.path ?? '');
      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Length', data.byteLength);
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      return reply.send(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    } catch (err) {
      return mapDocWorkspaceError(reply, err);
    }
  });

  app.post('/api/doc-workspaces/:id/brief', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { content?: unknown };
    const initialContent = typeof body.content === 'string' ? body.content : undefined;
    try {
      const result = app.pocket.docWorkspaces.createBrief(id, initialContent);
      return noStore(reply).code(result.created ? 201 : 200).send(result);
    } catch (err) {
      return mapDocWorkspaceError(reply, err);
    }
  });

  // Scoped streaming parser for raw file uploads into the workspace.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_request, payload, done) => {
      done(null, payload);
    });

    scope.post('/api/doc-workspaces/:id/files/upload', async (request, reply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { dir?: string; name?: string };
      const name = typeof query.name === 'string' ? query.name.trim() : '';
      if (!name) {
        return badRequest(reply, 'Missing required name query parameter.');
      }
      const dir = typeof query.dir === 'string' ? query.dir : '';
      const declared = Number(request.headers['content-length']);
      if (Number.isFinite(declared) && declared > LIMITS.maxAttachmentBytes) {
        reply.header('connection', 'close');
        return reply.code(413).send({
          error: { code: 'too_large', message: `File exceeds maximum size (${LIMITS.maxAttachmentBytes} bytes).` },
        });
      }
      const body = request.body as Readable | Buffer | string | undefined;
      if (!body) {
        return badRequest(reply, 'The request has no file body.');
      }
      const source: AsyncIterable<Buffer | Uint8Array> | Iterable<Buffer | Uint8Array> =
        Buffer.isBuffer(body)
          ? [body]
          : typeof body === 'string'
            ? [Buffer.from(body)]
            : body;

      try {
        const entry = await app.pocket.docWorkspaces.uploadFile(
          id,
          dir,
          name,
          source,
          LIMITS.maxAttachmentBytes,
        );
        return noStore(reply).code(201).send(entry);
      } catch (err) {
        return mapDocWorkspaceError(reply, err);
      }
    });
  });
};

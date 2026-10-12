import type { Readable } from 'node:stream';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { LIMITS, MAX_ATTACHMENT_NAME_CHARS } from '@pocketagent/protocol';
import { AttachmentError, tooLargeMessage } from '../attachments/index.js';

/**
 * Who an upload belongs to. An id is unknown to every other principal, so a
 * Hub cannot claim a file uploaded directly, nor one Hub another's. The
 * WebSocket path calls this with the upgrade request, which went through the
 * same `onRequest` gate, so both ends of one browser tab agree.
 */
export function attachmentPrincipal(request: FastifyRequest): string {
  if (request.mcpPrincipal) return `mcp:${request.mcpPrincipal.id}`;
  if (request.hubPrincipal) return `hub:${request.hubPrincipal.id}`;
  return 'session';
}

const STATUS_FOR: Record<AttachmentError['code'], number> = {
  not_found: 404,
  too_large: 413,
  too_many: 429,
  invalid: 400,
  forbidden: 403,
};

export function sendAttachmentError(reply: FastifyReply, err: AttachmentError): FastifyReply {
  return reply.code(STATUS_FOR[err.code]).send({ error: { code: `attachment_${err.code}`, message: err.message } });
}

/**
 * PA-136: `POST /api/attachments?name=<original filename>`, the file's own
 * bytes as the body.
 *
 * Authenticated like every other `/api/` route (it is in neither
 * `PUBLIC_API_PATHS` nor `/api/hooks/`), and a POST, so the Origin check
 * covers it.
 *
 * It is the second route after webhook delivery to own its body parsing, and
 * for the mirror-image reason: that one needs the exact bytes *buffered* to
 * verify an HMAC, this one needs them *streamed* so a 20 MB file never sits in
 * memory and an oversized one is cut off at the cap. Content-type parsers are
 * encapsulated per plugin scope, so every sibling route keeps the server's
 * 1 MiB JSON limit (`attachments-route.test.ts` proves it).
 */
export const attachmentRoutes: FastifyPluginAsync = async (app) => {
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    // A stream parser: Fastify enforces `bodyLimit` only for buffered ones, so
    // the cap is enforced while streaming instead, in `AttachmentStaging.stage`.
    scope.addContentTypeParser('*', (_request, payload, done) => {
      done(null, payload);
    });

    scope.post('/api/attachments', async (request, reply) => {
      const { attachmentStaging } = app.pocket;
      const query = request.query as { name?: unknown };
      const name = typeof query.name === 'string' ? query.name : '';
      if (name.trim().length === 0 || name.length > MAX_ATTACHMENT_NAME_CHARS) {
        return reply.code(400).send({
          error: { code: 'attachment_invalid', message: 'A file name (at most 255 characters) is required.' },
        });
      }
      // Refuse an honest client up front, before reading a byte; a dishonest
      // or chunked one is cut off by the streaming count instead.
      const declared = Number(request.headers['content-length']);
      if (Number.isFinite(declared) && declared > LIMITS.maxAttachmentBytes) {
        // Drain nothing, keep nothing: the connection is closed with the reply.
        reply.header('connection', 'close');
        return reply.code(413).send({ error: { code: 'attachment_too_large', message: tooLargeMessage() } });
      }
      const body = request.body as Readable | undefined;
      if (!body || typeof (body as Readable).pipe !== 'function') {
        return reply.code(400).send({ error: { code: 'attachment_invalid', message: 'The request has no file in it.' } });
      }
      const mediaType = typeof request.headers['content-type'] === 'string' ? request.headers['content-type'] : '';
      try {
        const staged = await attachmentStaging.stage(body, {
          name,
          mediaType,
          principal: attachmentPrincipal(request),
        });
        // Metadata only: the filename is something the user may not want in
        // a log, and the size and type are enough to debug with.
        request.log.info({ attachmentId: staged.attachmentId, size: staged.size, mediaType: staged.mediaType }, 'attachment staged');
        return staged;
      } catch (err) {
        if (err instanceof AttachmentError) {
          if (err.code === 'too_large') reply.header('connection', 'close');
          return sendAttachmentError(reply, err);
        }
        throw err;
      }
    });
  });
};

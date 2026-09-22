import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { bodyFramingFor, downstreamHeaders, upstreamHeaders } from './headers.js';

/**
 * Headers for an error the *Hub* writes on a hijacked reply.
 *
 * `reply.hijack()` takes the response out of Fastify's lifecycle, so the
 * `onSend` hook that adds the security headers never runs. For a *proxied*
 * response that is correct and invisible — `downstreamHeaders` relays the
 * backend's own `nosniff`/CSP, which is what should govern a backend's body
 * anyway. But these two error bodies are the Hub's, so they would otherwise be
 * the only responses it emits with no hardening headers at all.
 */
const ERROR_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
} as const;

export interface ProxyHttpOptions {
  readonly baseUrl: string;
  readonly credential: string;
  readonly upstreamPath: string;
  readonly hostId: string;
  /** `/h/<id>`, or `''` for the default host at the bare root. */
  readonly basePath: string;
}

/**
 * Forward one HTTP request to a backend and stream the answer back.
 *
 * Two things here are not incidental.
 *
 * **Nothing is parsed.** The route that mounts this removes every content-type
 * parser in its own plugin scope and hands back the raw stream, so the body
 * goes upstream byte-for-byte. That matters for the same reason it matters in
 * `routes/webhook-delivery.ts` on the backend: `JSON.parse` followed by
 * `JSON.stringify` preserves key order but not whitespace, unicode escaping or
 * number formatting, so a "transparent" proxy that round-trips through an
 * object is not transparent at all. Here it would also break any future
 * signed-body route and needlessly buffer uploads.
 *
 * **The reply is hijacked.** Writing to `reply.raw` rather than
 * `reply.send(stream)` keeps Fastify's serialisation, content-length
 * inference and `onSend` hooks out of the path entirely, which is what lets
 * `text/event-stream` — the planner's streamed turns, and PA-68's install log
 * — flow through unbuffered and unchunked.
 */
export async function proxyHttp(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ProxyHttpOptions,
): Promise<void> {
  let target: URL;
  try {
    target = new URL(options.upstreamPath, options.baseUrl);
  } catch {
    return void reply
      .code(502)
      .send({ error: { code: 'bad_host_url', message: 'This host has an unusable base URL.' } });
  }

  const transport = target.protocol === 'https:' ? https : http;
  const framing = bodyFramingFor(request.headers);
  const headers = upstreamHeaders(request.headers, {
    host: target.host,
    credential: options.credential,
    clientIp: request.ip,
    clientProto: request.protocol,
    framing,
  });

  reply.hijack();
  const raw = reply.raw;

  await new Promise<void>((resolve) => {
    const upstream = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (response) => {
        // PA-66 D21: a backend's 401 must not reach the browser as-is.
        // `App.tsx` drops the *whole* app to the login screen on any 401, so
        // one revoked credential would sign the operator out of every other
        // host too. Translating it says what actually happened and keeps the
        // Hub session intact. 502 rather than 401 is the point; the body names
        // the host so the UI can mark that row rather than guessing.
        // Deliberately *not* 403: a backend's 403 is a domain error (e.g.
        // forbidden directory, bad origin), not a rejected hub credential.
        if (response.statusCode === 401) {
          response.resume();
          request.log.warn(
            { hostId: options.hostId, status: response.statusCode },
            'backend rejected the hub credential',
          );
          raw.writeHead(502, ERROR_HEADERS);
          raw.end(
            JSON.stringify({
              error: {
                code: 'host_credential_rejected',
                message: `${options.hostId} rejected this Hub's credential. Re-bind it, or check whether it was revoked on that machine.`,
              },
            }),
          );
          resolve();
          return;
        }
        raw.writeHead(
          response.statusCode ?? 502,
          downstreamHeaders(response.headers, {
            baseUrl: options.baseUrl,
            basePath: options.basePath,
          }),
        );
        response.pipe(raw);
        response.on('end', resolve);
        response.on('error', () => {
          raw.destroy();
          resolve();
        });
      },
    );

    upstream.on('error', (error: Error) => {
      request.log.warn({ hostId: options.hostId, err: error.message }, 'proxy request failed');
      if (!raw.headersSent) {
        raw.writeHead(502, ERROR_HEADERS);
        raw.end(
          JSON.stringify({
            error: {
              code: 'host_unreachable',
              message: `Could not reach ${options.hostId}.`,
            },
          }),
        );
      } else {
        raw.destroy();
      }
      resolve();
    });

    // If the browser goes away mid-request, stop asking the backend to finish.
    raw.on('close', () => {
      upstream.destroy();
    });

    if (framing.kind === 'none') {
      // No framing means no body, so there is nothing to pipe — and piping
      // anyway is precisely how an unframed body becomes a smuggled request.
      // `resume()` drains whatever the client sent regardless, so a client
      // that sends a body on a method that cannot have one does not stall.
      request.raw.resume();
      upstream.end();
    } else {
      request.raw.pipe(upstream);
    }
  });
}

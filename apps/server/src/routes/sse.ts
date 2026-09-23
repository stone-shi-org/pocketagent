import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * The one place this server writes `text/event-stream`.
 *
 * Extracted from `routes/planner.ts` when PA-68 needed a second streaming
 * route. The frame format is the contract the browser's own hand-rolled reader
 * depends on (`api/client.ts` splits on `\n\n` and strips a `data:` prefix), so
 * a second copy of these four lines is a second chance for the two halves to
 * disagree about it.
 *
 * ## Why the options exist rather than being always-on
 *
 * A planner chat turn and an agent install are both SSE, but they have
 * different failure modes, and the difference is duration. A turn lasts
 * seconds with the browser watching; an install lasts minutes, during which a
 * reverse proxy will hit its idle timeout and a phone will lock its screen. So
 * the install stream opts into a heartbeat and a disconnect handler, and the
 * chat stream — which has shipped and been tested without either — keeps its
 * existing behaviour. Turning those on for the planner as a side effect of a
 * refactor would be a behaviour change nobody asked for.
 *
 * `x-accel-buffering: no` is the one thing that *is* unconditional, and that is
 * a deliberate fix rather than an oversight: nginx buffers proxied responses by
 * default, which defeats SSE entirely, and a planner chat behind a proxy has
 * exactly the same problem an install does. Stating it here because it is the
 * single respect in which the planner stream's bytes changed.
 *
 * Note this writes through `reply.hijack()`, which means Fastify's `onSend`
 * hook does not run and the security headers it adds are absent from these two
 * responses. That was already true of the planner stream; it is recorded here
 * because this is now the place someone would look.
 */
export interface SseStreamOptions {
  /**
   * Interval for a `: ping` comment frame. A comment is the SSE-native no-op —
   * every parser ignores it, including the browser's own reader here, which
   * drops any frame that is not valid JSON after the prefix. Omit for no
   * heartbeat.
   */
  heartbeatMs?: number;
  /**
   * Called when the client goes away. For a long job this must *not* cancel
   * the work — an operator navigating away from an install has not asked to
   * abort it — it only stops writing to a socket that is gone.
   */
  onClose?: () => void;
}

export interface SseStream {
  /** One JSON payload as one `data:` frame. No-op once the socket is gone. */
  write(payload: unknown): void;
  /** Ends the response and stops the heartbeat. Idempotent. */
  end(): void;
  /** True once the client has disconnected. */
  get closed(): boolean;
}

/**
 * Commit the response to being a stream and return a writer.
 *
 * Call this only after any synchronous precondition has been checked: past
 * this point the headers are sent and there is no status code left to change,
 * which is why both callers do their validation first and turn later failures
 * into in-band events instead.
 */
export function openSseStream(
  request: FastifyRequest,
  reply: FastifyReply,
  options: SseStreamOptions = {},
): SseStream {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // Nginx buffers proxied responses by default, which for SSE means the
    // operator sees nothing until the whole install finishes — the "silent
    // spinner" this feature exists to avoid. Meaningless to a direct client
    // and harmless when no proxy is present.
    'x-accel-buffering': 'no',
  });
  reply.raw.flushHeaders?.();

  let closed = false;
  let heartbeat: NodeJS.Timeout | undefined;

  const stop = (): void => {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  };

  // PA-90: Listen on the raw response's close event, NOT request.raw.
  // `request.raw` is the incoming request body stream, which emits 'close'
  // as soon as the POST request body is consumed (within milliseconds).
  // Listening to request.raw caused the response to be prematurely destroyed
  // on every POST with a body, aborting the SSE stream and throwing a network error
  // in the client.
  // `reply.raw.on('close')` fires when the response finishes cleanly (writableEnded is true)
  // or when the client disconnected prematurely (writableEnded is false).
  reply.raw.on('close', () => {
    if (closed) return;
    closed = true;
    stop();
    if (!reply.raw.writableEnded) {
      options.onClose?.();
      if (!reply.raw.destroyed) {
        reply.raw.destroy();
      }
    }
  });

  if (options.heartbeatMs !== undefined) {
    heartbeat = setInterval(() => {
      if (closed || reply.raw.destroyed) return;
      reply.raw.write(': ping\n\n');
    }, options.heartbeatMs);
    heartbeat.unref?.();
  }

  return {
    write(payload: unknown): void {
      if (closed || reply.raw.destroyed) return;
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    },
    end(): void {
      stop();
      if (closed) return;
      closed = true;
      if (!reply.raw.destroyed) {
        reply.raw.end();
      }
    },
    get closed(): boolean {
      return closed || reply.raw.destroyed;
    },
  };
}

import { describe, expect, it, vi } from 'vitest';
import { TelegramApiError, TelegramClient } from '../src/telegram/client.js';
import { isEntityParseError, sendMarkdown, sendPlainText } from '../src/telegram/send.js';

/**
 * PA-105: the plain-text fallback. A formatting bug may lose the formatting,
 * never the message. Driven against a stubbed Bot API at the `fetch`
 * boundary, the same posture `telegram-bridge.test.ts` takes.
 */

interface Call {
  method: string;
  body: Record<string, unknown>;
}

function transport(answer: (body: Record<string, unknown>) => Response): {
  client: TelegramClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ method: url.toString().split('/').pop() ?? '', body });
    return answer(body);
  }) as unknown as typeof fetch;
  return { client: new TelegramClient({ token: 't', fetchImpl }), calls };
}

const ok = () => new Response(JSON.stringify({ ok: true, result: {} }));
const fail = (status: number, description: string) =>
  new Response(JSON.stringify({ ok: false, error_code: status, description }), { status });

describe('sendMarkdown', () => {
  it('sends Markdown as parse_mode HTML', async () => {
    const { client, calls } = transport(ok);
    await sendMarkdown(client, '1', 'Hello **world**');
    expect(calls).toEqual([
      {
        method: 'sendMessage',
        body: { chat_id: '1', text: 'Hello <b>world</b>', parse_mode: 'HTML' },
      },
    ]);
  });

  it("resends the chunk's original Markdown as plain text when Telegram cannot parse the entities, and warns", async () => {
    const { client, calls } = transport((body) =>
      body.parse_mode
        ? fail(400, "Bad Request: can't parse entities: unexpected end tag at byte offset 9")
        : ok(),
    );
    const logger = { warn: vi.fn() };
    await sendMarkdown(client, '1', 'Hello **world** & <you>', { logger });

    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual({ chat_id: '1', text: 'Hello **world** & <you>' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [obj, msg] = logger.warn.mock.calls[0]!;
    expect(msg).toMatch(/plain text/);
    // The log line names Telegram's error, never the message itself.
    expect(JSON.stringify(obj)).toContain("can't parse entities");
    expect(JSON.stringify(obj)).not.toContain('world');
  });

  it('falls back per chunk, so one bad chunk does not cost the others their formatting', async () => {
    const md = `**first**\n\n${'filler '.repeat(700)}\n\n**BROKEN**`;
    const { client, calls } = transport((body) =>
      body.parse_mode && String(body.text).includes('BROKEN')
        ? fail(400, "Bad Request: can't parse entities")
        : ok(),
    );
    const sent = await sendMarkdown(client, '1', md);
    expect(sent).toBeGreaterThan(1);
    const modes = calls.map((c) => c.body.parse_mode ?? 'plain');
    // Every chunk is tried formatted once; only the broken one is resent plain.
    expect(modes.filter((m) => m === 'HTML')).toHaveLength(sent);
    expect(modes.filter((m) => m === 'plain')).toHaveLength(1);
    // The resend is that chunk's original Markdown, markers and all.
    expect(calls.at(-1)!.body.parse_mode).toBeUndefined();
    expect(String(calls.at(-1)!.body.text).endsWith('\n\n**BROKEN**')).toBe(true);
    expect(calls[0]!.body.text).toMatch(/^<b>first<\/b>/);
  });

  it('does not retry an error that formatting did not cause', async () => {
    for (const [status, description] of [
      [400, 'Bad Request: chat not found'],
      [401, 'Unauthorized'],
      [403, 'Forbidden: bot was blocked by the user'],
    ] as const) {
      const { client, calls } = transport(() => fail(status, description));
      await expect(sendMarkdown(client, '1', '**x**')).rejects.toThrow(description);
      expect(calls).toHaveLength(1);
    }
  });

  it('sends a chunk with no visible text as its source rather than an empty message', async () => {
    const { client, calls } = transport(ok);
    await sendMarkdown(client, '1', '```\n```');
    expect(calls[0]!.body).toEqual({ chat_id: '1', text: '```\n```' });
  });
});

describe('sendPlainText', () => {
  it('never sets a parse_mode, and splits long text', async () => {
    const { client, calls } = transport(ok);
    await sendPlainText(
      client,
      '1',
      Array.from({ length: 3 }, () => '**x** '.repeat(400)).join('\n\n'),
    );
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) {
      expect(c.body.parse_mode).toBeUndefined();
      expect(String(c.body.text).length).toBeLessThanOrEqual(4096);
    }
  });
});

describe('isEntityParseError', () => {
  it('is true only for a 400 naming entity parsing', () => {
    expect(isEntityParseError(new TelegramApiError("Bad Request: can't parse entities", 400))).toBe(
      true,
    );
    expect(isEntityParseError(new TelegramApiError("Bad Request: can't parse entities", 500))).toBe(
      false,
    );
    expect(isEntityParseError(new TelegramApiError('Bad Request: message is too long', 400))).toBe(
      false,
    );
    expect(isEntityParseError(new Error("can't parse entities"))).toBe(false);
  });
});

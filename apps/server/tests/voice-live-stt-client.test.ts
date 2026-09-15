import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLiveSttClient, LiveSttError, pcm16ToWav } from '../src/voice/live-stt-client.js';

/**
 * A real local HTTP server standing in for `live-stt`'s `/v1/audio/transcriptions`,
 * rather than a mocked `fetch` — the same reasoning `helpers-mcp-server.ts`
 * gives for its MCP fakes: this proves the client's `multipart/form-data`
 * request is actually well-formed wire traffic, not just this codebase's own
 * assumption about the shape.
 */
function startFakeLiveStt(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handler(req, res, Buffer.concat(chunks)));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe('pcm16ToWav', () => {
  it('produces a well-formed 16kHz mono 16-bit RIFF header', () => {
    const pcm = Buffer.from(new Int16Array([1, -1, 1000]).buffer);
    const wav = pcm16ToWav(pcm);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1); // channels
    expect(wav.readUInt32LE(24)).toBe(16000); // sample rate
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.readUInt32LE(40)).toBe(pcm.length); // data chunk size
    expect(wav.subarray(44)).toEqual(pcm);
  });
});

describe('createLiveSttClient.transcribe', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('posts multipart/form-data and returns the transcript on success', async () => {
    let receivedContentType = '';
    let receivedBody = '';
    const server = await startFakeLiveStt((req, res, body) => {
      receivedContentType = req.headers['content-type'] ?? '';
      receivedBody = body.toString('latin1');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: 'hello world' }));
    });
    close = server.close;

    const client = createLiveSttClient(server.url);
    const text = await client.transcribe(Buffer.from(new Int16Array([1, 2, 3]).buffer));

    expect(text).toBe('hello world');
    expect(receivedContentType).toMatch(/^multipart\/form-data/);
    // The uploaded file part must carry a real WAV header, not raw PCM.
    expect(receivedBody).toContain('RIFF');
    expect(receivedBody).toContain('name="file"');
    expect(receivedBody).toContain('name="response_format"');
  });

  it('surfaces a 503 (VRAM/capacity) as a retryable LiveSttError with the nested error message', async () => {
    const server = await startFakeLiveStt((_req, res) => {
      res
        .writeHead(503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'insufficient VRAM: 100MB free, 500MB required' } }));
    });
    close = server.close;

    const client = createLiveSttClient(server.url);
    await expect(client.transcribe(Buffer.alloc(10))).rejects.toMatchObject({
      name: 'LiveSttError',
      retryable: true,
      message: expect.stringContaining('insufficient VRAM'),
    });
  });

  it('surfaces a 400 as a non-retryable LiveSttError', async () => {
    const server = await startFakeLiveStt((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'bad wav' } }));
    });
    close = server.close;

    const client = createLiveSttClient(server.url);
    let caught: unknown;
    try {
      await client.transcribe(Buffer.alloc(10));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LiveSttError);
    expect((caught as LiveSttError).retryable).toBe(false);
  });

  it('treats a malformed JSON response as a non-retryable error', async () => {
    const server = await startFakeLiveStt((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('not json');
    });
    close = server.close;

    const client = createLiveSttClient(server.url);
    await expect(client.transcribe(Buffer.alloc(10))).rejects.toMatchObject({ retryable: false });
  });

  it('treats an unreachable server as a retryable error', async () => {
    // Nothing listens on this port.
    const client = createLiveSttClient('http://127.0.0.1:1');
    await expect(client.transcribe(Buffer.alloc(10))).rejects.toMatchObject({
      name: 'LiveSttError',
      retryable: true,
    });
  });
});

describe('createLiveSttClient.synthesize', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('posts JSON with response_format=pcm (D6) and no stream field (D5), returning raw PCM bytes', async () => {
    let receivedBody: unknown;
    let receivedContentType = '';
    const fakePcm = Buffer.from(new Int16Array([1, 2, 3, 4]).buffer);
    const server = await startFakeLiveStt((req, res, body) => {
      receivedContentType = req.headers['content-type'] ?? '';
      receivedBody = JSON.parse(body.toString('utf8'));
      res.writeHead(200, { 'content-type': 'audio/pcm' }).end(fakePcm);
    });
    close = server.close;

    const client = createLiveSttClient(server.url);
    const result = await client.synthesize('Turn on the lights.');

    expect(receivedContentType).toBe('application/json');
    expect(receivedBody).toEqual({ input: 'Turn on the lights.', response_format: 'pcm' });
    expect(result.pcm.equals(fakePcm)).toBe(true);
    expect(result.sampleRateHz).toBe(24000);
  });

  it('surfaces a 503 with the flatter speech error shape ({"error": "..."}), not transcribe\'s nested one', async () => {
    const server = await startFakeLiveStt((_req, res) => {
      res
        .writeHead(503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: 'insufficient free VRAM for TTS (100 MiB free, 500 MiB required)' }));
    });
    close = server.close;

    const client = createLiveSttClient(server.url);
    await expect(client.synthesize('hello')).rejects.toMatchObject({
      name: 'LiveSttError',
      retryable: true,
      message: expect.stringContaining('insufficient free VRAM'),
    });
  });

  it('surfaces a non-503 error as non-retryable', async () => {
    const server = await startFakeLiveStt((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'text is required' }));
    });
    close = server.close;

    const client = createLiveSttClient(server.url);
    await expect(client.synthesize('')).rejects.toMatchObject({ retryable: false });
  });

  it('treats an unreachable server as a retryable error', async () => {
    const client = createLiveSttClient('http://127.0.0.1:1');
    await expect(client.synthesize('hello')).rejects.toMatchObject({
      name: 'LiveSttError',
      retryable: true,
    });
  });
});

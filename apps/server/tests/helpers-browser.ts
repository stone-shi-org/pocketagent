import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { LaunchedChromium } from '../src/browser/chromium.js';
import type { BrowserServiceOptions } from '../src/browser/service.js';

/**
 * PA-178: a fake Chromium for the browser tests, so CI needs no browser.
 *
 * It is a real WebSocket server speaking the handful of CDP methods the
 * service and the viewer use, and it records every command it receives so a
 * test can assert what reached "the browser" (an `Input.*` event, a refused
 * `Page.navigate` that never arrived). The "process" is an EventEmitter whose
 * pid is far above any real pid, so a group kill can never reach a real
 * process — `killGroup` also refuses pids ≤ 1.
 */

export interface FakeChromium {
  /** Every CDP command received, in order. */
  commands: { method: string; params: Record<string, unknown>; sessionId?: string }[];
  /** Launches so far, and the argv of each. */
  launches: string[][];
  options: Partial<BrowserServiceOptions>;
  /** Push a target URL change, as an agent navigating would cause. */
  navigateTarget(targetId: string, url: string): void;
  /** Open a JS dialog on the first attached page session. */
  openDialog(type: 'alert' | 'confirm' | 'prompt', message: string): void;
  /** Make the "browser" exit as if it crashed. */
  crash(): void;
  close(): Promise<void>;
  /** A data dir outside the test's workspace root. */
  dataDir: string;
}

const FAKE_PID_BASE = 900_000_000;
// 1×1 white JPEG.
const FRAME =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

export async function startFakeChromium(): Promise<FakeChromium> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const port = (wss.address() as { port: number }).port;
  const commands: FakeChromium['commands'] = [];
  const launches: string[][] = [];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa178-data-'));
  let child: (EventEmitter & { pid: number; kill: (s?: string) => boolean }) | null = null;
  let socket: WebSocket | null = null;
  const targets = new Map<string, { url: string; title: string }>([['T1', { url: 'about:blank', title: '' }]]);
  const sessions = new Map<string, string>(); // sessionId -> targetId
  const casting = new Map<string, NodeJS.Timeout>();
  let nextSession = 1;
  let nextTarget = 2;

  const sendEvent = (method: string, params: Record<string, unknown>, sessionId?: string): void => {
    socket?.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
  };
  const exit = (): void => {
    for (const t of casting.values()) clearInterval(t);
    casting.clear();
    socket?.close();
    const c = child;
    child = null;
    c?.emit('exit', 0, null);
  };

  wss.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
      const params = msg.params ?? {};
      commands.push({ method: msg.method, params, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) });
      let result: Record<string, unknown> = {};
      switch (msg.method) {
        case 'Target.getTargets':
          result = {
            targetInfos: [...targets].map(([targetId, t]) => ({ targetId, type: 'page', url: t.url, title: t.title })),
          };
          break;
        case 'Target.attachToTarget': {
          const sessionId = `S${nextSession++}`;
          sessions.set(sessionId, String(params.targetId));
          result = { sessionId };
          break;
        }
        case 'Target.createTarget': {
          const targetId = `T${nextTarget++}`;
          targets.set(targetId, { url: String(params.url ?? 'about:blank'), title: '' });
          setImmediate(() =>
            sendEvent('Target.targetCreated', { targetInfo: { targetId, type: 'page', url: params.url, title: '' } }),
          );
          result = { targetId };
          break;
        }
        case 'Target.closeTarget': {
          const targetId = String(params.targetId);
          targets.delete(targetId);
          setImmediate(() => sendEvent('Target.targetDestroyed', { targetId }));
          result = { success: true };
          break;
        }
        case 'Page.startScreencast': {
          const sid = msg.sessionId!;
          clearInterval(casting.get(sid));
          casting.set(
            sid,
            setInterval(
              () =>
                sendEvent(
                  'Page.screencastFrame',
                  {
                    data: FRAME,
                    sessionId: 1,
                    metadata: { offsetTop: 0, pageScaleFactor: 1, deviceWidth: 390, deviceHeight: 760, scrollOffsetX: 0, scrollOffsetY: 0 },
                  },
                  sid,
                ),
              10,
            ),
          );
          break;
        }
        case 'Page.stopScreencast':
          clearInterval(casting.get(msg.sessionId!));
          casting.delete(msg.sessionId!);
          break;
        case 'Page.navigate': {
          const targetId = sessions.get(msg.sessionId!);
          if (targetId) {
            targets.set(targetId, { url: String(params.url), title: '' });
            setImmediate(() =>
              sendEvent('Target.targetInfoChanged', { targetInfo: { targetId, type: 'page', url: params.url, title: '' } }),
            );
          }
          break;
        }
        case 'Page.getNavigationHistory':
          result = { currentIndex: 0, entries: [{ id: 1, url: 'about:blank' }] };
          break;
        case 'Browser.close':
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
          setTimeout(exit, 5);
          return;
      }
      ws.send(JSON.stringify({ id: msg.id, result }));
    });
  });

  const options: Partial<BrowserServiceOptions> = {
    dataDir,
    findExecutable: () => '/fake/chrome',
    majorVersion: () => '155',
    probeSandbox: async () => false,
    launch: async (_exe, args): Promise<LaunchedChromium> => {
      launches.push(args);
      const emitter = new EventEmitter() as EventEmitter & { pid: number; kill: (s?: string) => boolean };
      emitter.pid = FAKE_PID_BASE + launches.length;
      emitter.kill = () => {
        setImmediate(exit);
        return true;
      };
      child = emitter;
      return {
        child: emitter as unknown as LaunchedChromium['child'],
        pid: emitter.pid,
        browserWsUrl: `ws://127.0.0.1:${port}/devtools/browser/fake`,
        cdpUrl: `http://127.0.0.1:${port}`,
      };
    },
  };

  return {
    commands,
    launches,
    options,
    dataDir,
    navigateTarget(targetId, url) {
      targets.set(targetId, { url, title: '' });
      sendEvent('Target.targetInfoChanged', { targetInfo: { targetId, type: 'page', url, title: '' } });
    },
    openDialog(type, message) {
      const sid = [...sessions.keys()].at(-1);
      if (sid) sendEvent('Page.javascriptDialogOpening', { type, message, url: 'about:blank' }, sid);
    },
    crash: exit,
    async close() {
      exit();
      await new Promise<void>((r) => wss.close(() => r()));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

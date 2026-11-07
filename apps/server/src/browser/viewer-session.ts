import {
  isViewerNavigableUrl,
  type BrowserClientMessage,
  type BrowserServerMessage,
  type ScreencastMetadata,
} from '@pocketagent/protocol';
import type { CdpEvent } from './cdp.js';
import type { BrowserInstance, BrowserInstanceEvent, BrowserService } from './service.js';

/**
 * PA-178: one viewer's connection to one shared browser.
 *
 * It attaches its *own* flattened CDP session to the selected tab, so the
 * viewport override it applies (a phone-shaped layout) lives only as long as
 * that session: when the viewer leaves, Chromium drops the override and the
 * agent's view is what it was.
 *
 * Frames and input pass straight through and are never logged or kept — a
 * person types passwords into this.
 */

/** At most one frame per this many ms (the spike measured ≈18 KB a frame at q60). */
export const FRAME_INTERVAL_MS = 100;
/** Skip a frame tick while the socket still holds this much unsent data. */
export const MAX_BUFFERED_BYTES = 512 * 1024;
/** Navigation within this long of the viewer's own input is the viewer's, not the agent's. */
const OWN_ACTION_WINDOW_MS = 3_000;
/** Frames are 2× now (see `buildChromiumArgs`); q70 keeps text edges clean at ~2–3× the bytes of the old 1× q60. */
const SCREENCAST_QUALITY = 70;
/** After a tap, wait this long for the page's own focus handling before asking what has focus. */
const EDITABLE_PROBE_DELAY_MS = 150;

/**
 * Does the page's focused element take typing? Run in the page with
 * `Runtime.evaluate` (no `Runtime.enable`, which sites can detect), through
 * open shadow roots. A focused iframe counts: its document is another origin
 * this cannot look into, and a payment or sign-in frame is exactly where
 * someone types. With `scroll`, the field is scrolled to the middle of the
 * view — the phone's keyboard just shrank the viewport over it.
 */
function editableProbe(scroll: boolean): string {
  return `(() => {
  let a = document.activeElement;
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
  if (!a || a === document.body || a === document.documentElement) return false;
  let ok = false;
  if (a.tagName === 'IFRAME' || a.isContentEditable) ok = true;
  else if (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT') ok = a.tagName === 'TEXTAREA' && !a.readOnly && !a.disabled;
  else if (a.tagName === 'INPUT') {
    const t = String(a.type || 'text').toLowerCase();
    ok = !['button','submit','reset','checkbox','radio','file','image','range','color','hidden'].includes(t) && !a.readOnly && !a.disabled;
  }
  if (ok && ${scroll ? 'true' : 'false'} && a.scrollIntoView) a.scrollIntoView({ block: 'center', inline: 'nearest' });
  return ok;
})()`;
}

export interface ViewerSessionOptions {
  service: BrowserService;
  instance: BrowserInstance;
  send: (message: BrowserServerMessage) => void;
  bufferedAmount: () => number;
  /** The browser went away; the route closes the socket. */
  onClosed: (reason: string) => void;
  now?: () => number;
}

interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
}

export class ViewerSession {
  private targetId: string | null = null;
  private sessionId: string | null = null;
  private visible = false;
  private viewport: Viewport | null = null;
  private casting = false;
  private latest: { data: string; metadata: ScreencastMetadata } | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private lastSentAt = 0;
  private lastOwnActionAt = 0;
  private probeTimer: NodeJS.Timeout | null = null;
  private lastEditable: boolean | null = null;
  private disposed = false;
  private readonly unsubscribers: (() => void)[] = [];
  private readonly releaseHold: () => void;
  private readonly now: () => number;

  constructor(private readonly opts: ViewerSessionOptions) {
    this.now = opts.now ?? Date.now;
    this.releaseHold = opts.service.holdViewer(opts.instance.id);
    this.unsubscribers.push(opts.instance.cdp.on((e) => this.onCdpEvent(e)));
    this.unsubscribers.push(opts.service.subscribe(opts.instance.id, (e) => void this.onInstanceEvent(e)));
  }

  get cdp() {
    return this.opts.instance.cdp;
  }

  /** Attach to the first tab (making one if there is none) and say hello. */
  async start(): Promise<void> {
    const focus = this.opts.instance.focusTargetId;
    const tabs = [...this.opts.instance.targets.keys()];
    // The tab a handoff opened, else the newest — the page someone just went to.
    const pick = focus && this.opts.instance.targets.has(focus) ? focus : tabs.at(-1);
    if (pick) await this.selectTab(pick);
    else await this.newTab();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    for (const u of this.unsubscribers) u();
    this.releaseHold();
    const sessionId = this.sessionId;
    if (sessionId && this.cdp.isOpen) {
      // Detaching drops this session's viewport override and screencast.
      void this.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
    }
  }

  async handle(message: BrowserClientMessage): Promise<void> {
    if (this.disposed) return;
    const sid = this.sessionId;
    switch (message.type) {
      case 'visible':
        this.visible = message.visible;
        if (this.visible) await this.startCast();
        else await this.stopCast();
        return;
      case 'resize': {
        // Only a view that got *shorter* (a phone keyboard opening) re-centres
        // the focused field; growing back, or any other resize, must not undo
        // where the person scrolled.
        const shrank = this.viewport !== null && message.height < this.viewport.height;
        this.viewport = {
          width: message.width,
          height: message.height,
          deviceScaleFactor: message.deviceScaleFactor,
          mobile: message.mobile,
        };
        await this.applyViewport();
        if (this.casting) {
          await this.stopCast();
          await this.startCast();
        }
        // A phone's keyboard opening is a resize: keep the field in view.
        if (shrank) this.scheduleEditableProbe(true);
        return;
      }
      case 'tab-select':
        if (!this.opts.instance.targets.has(message.tabId)) throw new Error('No such tab.');
        await this.selectTab(message.tabId);
        return;
      case 'tab-new':
        this.ownAction();
        await this.newTab();
        return;
      case 'tab-close':
        if (!this.opts.instance.targets.has(message.tabId)) throw new Error('No such tab.');
        this.ownAction();
        await this.cdp.send('Target.closeTarget', { targetId: message.tabId });
        return;
    }
    if (!sid) throw new Error('No tab is selected.');
    this.ownAction();
    switch (message.type) {
      case 'mouse': {
        const pressOrRelease = message.event === 'mousePressed' || message.event === 'mouseReleased';
        this.sendInput(
          'Input.dispatchMouseEvent',
          {
            type: message.event,
            x: message.x,
            y: message.y,
            button: message.button ?? (pressOrRelease ? 'left' : 'none'),
            clickCount: message.clickCount ?? (pressOrRelease ? 1 : 0),
            ...(message.event === 'mouseWheel' ? { deltaX: message.deltaX ?? 0, deltaY: message.deltaY ?? 0 } : {}),
            modifiers: message.modifiers ?? 0,
          },
          sid,
        );
        if (message.event === 'mouseReleased') this.scheduleEditableProbe(false);
        return;
      }
      case 'key':
        this.sendInput(
          'Input.dispatchKeyEvent',
          {
            // `rawKeyDown` for a key that types nothing (an arrow, Backspace),
            // `keyDown` with `text` for one that does (Enter is "\r").
            type: message.event === 'keyUp' ? 'keyUp' : message.text ? 'keyDown' : 'rawKeyDown',
            key: message.key,
            code: message.code,
            ...(message.keyCode !== undefined ? { windowsVirtualKeyCode: message.keyCode } : {}),
            ...(message.text ? { text: message.text } : {}),
            modifiers: message.modifiers ?? 0,
          },
          sid,
        );
        // Tab and Enter move focus; so can a page's own key handler.
        if (message.event === 'keyUp' && (message.key === 'Tab' || message.key === 'Enter' || message.key === 'Escape')) {
          this.scheduleEditableProbe(false);
        }
        return;
      case 'insertText':
        this.sendInput('Input.insertText', { text: message.text }, sid);
        return;
      case 'navigate':
        // Re-checked here as well as by the schema: only http(s) from a phone.
        if (!isViewerNavigableUrl(message.url)) throw new Error('Only http(s) addresses can be opened from the viewer.');
        await this.cdp.send('Page.navigate', { url: message.url }, sid);
        return;
      case 'reload':
        await this.cdp.send('Page.reload', {}, sid);
        return;
      case 'back':
      case 'forward': {
        const history = await this.cdp.send<{ currentIndex: number; entries: { id: number }[] }>(
          'Page.getNavigationHistory',
          {},
          sid,
        );
        const entry = history.entries[history.currentIndex + (message.type === 'back' ? -1 : 1)];
        if (entry) await this.cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, sid);
        return;
      }
      case 'dialog-accept':
        await this.cdp.send(
          'Page.handleJavaScriptDialog',
          { accept: true, ...(message.promptText !== undefined ? { promptText: message.promptText } : {}) },
          sid,
        );
        return;
      case 'dialog-dismiss':
        await this.cdp.send('Page.handleJavaScriptDialog', { accept: false }, sid);
        return;
    }
  }

  /**
   * Input is sent without waiting for its reply. Found against the real
   * browser: `Input.dispatchMouseEvent` does not return while a `confirm()`
   * the click opened is showing, so awaiting it in this connection's ordered
   * chain held the person's own "OK" behind it until the command timed out.
   * Order is still kept — commands go out on one socket in the order sent,
   * and Chromium applies them in that order.
   */
  private sendInput(method: string, params: Record<string, unknown>, sessionId: string): void {
    this.cdp.send(method, params, sessionId).catch(() => {
      // A dialog left open past the command timeout, or the tab closed under
      // the input: neither is the person's mistake to be told about.
    });
  }

  private scheduleEditableProbe(scroll: boolean): void {
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      void this.probeEditable(scroll);
    }, EDITABLE_PROBE_DELAY_MS);
  }

  /** Not awaited by anyone: a page held by an open `confirm()` answers nothing until it closes. */
  private async probeEditable(scroll: boolean): Promise<void> {
    const sid = this.sessionId;
    if (!sid || this.disposed) return;
    try {
      const res = await this.cdp.send<{ result?: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression: editableProbe(scroll), returnByValue: true, silent: true },
        sid,
      );
      if (this.disposed || sid !== this.sessionId) return;
      const editable = res.result?.value === true;
      this.lastEditable = editable;
      this.opts.send({ type: 'editable', editable });
    } catch {
      // The tab navigated or closed under the probe; the next tap asks again.
    }
  }

  private ownAction(): void {
    this.lastOwnActionAt = this.now();
    this.opts.service.touch(this.opts.instance.id);
  }

  private async newTab(): Promise<void> {
    const { targetId } = await this.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    this.opts.instance.targets.set(targetId, this.opts.instance.targets.get(targetId) ?? { url: 'about:blank', title: '' });
    await this.selectTab(targetId);
  }

  private async selectTab(targetId: string): Promise<void> {
    const previous = this.sessionId;
    if (previous) {
      await this.stopCast();
      await this.cdp.send('Target.detachFromTarget', { sessionId: previous }).catch(() => undefined);
    }
    this.sessionId = null;
    this.targetId = targetId;
    const { sessionId } = await this.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    if (this.disposed) {
      void this.cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
      return;
    }
    this.sessionId = sessionId;
    await this.cdp.send('Page.enable', {}, sessionId);
    await this.applyViewport();
    this.sendTabs();
    const t = this.opts.instance.targets.get(targetId);
    if (t) this.opts.send({ type: 'url', url: t.url, title: t.title });
    if (this.visible) await this.startCast();
    if (this.lastEditable) this.scheduleEditableProbe(false);
  }

  private async applyViewport(): Promise<void> {
    const sid = this.sessionId;
    if (!sid || !this.viewport) return;
    const v = this.viewport;
    await this.cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: v.width, height: v.height, deviceScaleFactor: v.deviceScaleFactor, mobile: v.mobile },
      sid,
    );
    // `maxTouchPoints` must be 1–16 even when disabling (found against the
    // real browser: 0 is refused, which failed every desktop viewport).
    await this.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: v.mobile, maxTouchPoints: 1 }, sid);
  }

  private async startCast(): Promise<void> {
    const sid = this.sessionId;
    if (!sid || this.casting) return;
    const v = this.viewport;
    this.casting = true;
    await this.cdp.send(
      'Page.startScreencast',
      {
        format: 'jpeg',
        quality: SCREENCAST_QUALITY,
        ...(v
          ? {
              maxWidth: Math.round(v.width * v.deviceScaleFactor),
              maxHeight: Math.round(v.height * v.deviceScaleFactor),
            }
          : {}),
        everyNthFrame: 1,
      },
      sid,
    );
  }

  private async stopCast(): Promise<void> {
    this.latest = null;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const sid = this.sessionId;
    if (!sid || !this.casting) return;
    this.casting = false;
    await this.cdp.send('Page.stopScreencast', {}, sid).catch(() => undefined);
  }

  /**
   * Latest wins. The spike found a delayed ack does not cap the rate (Chrome
   * keeps several frames in flight; 30 fps, ~530 KB/s), so every frame is
   * acked at once, only the newest is kept, and it is sent at most every
   * `FRAME_INTERVAL_MS` — and not while the socket is still draining.
   */
  private onFrame(params: Record<string, unknown>): void {
    const sid = this.sessionId;
    if (!sid) return;
    void this.cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sid).catch(() => undefined);
    if (!this.visible || !this.casting) return;
    this.latest = { data: String(params.data ?? ''), metadata: params.metadata as ScreencastMetadata };
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    const wait = Math.max(0, FRAME_INTERVAL_MS - (this.now() - this.lastSentAt));
    this.flushTimer = setTimeout(() => this.flush(), wait);
  }

  private flush(): void {
    this.flushTimer = null;
    if (!this.latest || this.disposed) return;
    if (this.opts.bufferedAmount() > MAX_BUFFERED_BYTES) {
      this.flushTimer = setTimeout(() => this.flush(), 50);
      return;
    }
    const frame = this.latest;
    this.latest = null;
    this.lastSentAt = this.now();
    this.opts.send({ type: 'frame', data: frame.data, metadata: frame.metadata });
  }

  private onCdpEvent(event: CdpEvent): void {
    if (!event.sessionId || event.sessionId !== this.sessionId) return;
    switch (event.method) {
      case 'Page.screencastFrame':
        this.onFrame(event.params);
        return;
      case 'Page.javascriptDialogOpening': {
        const type = event.params.type as string;
        this.opts.send({
          type: 'dialog',
          dialogType: type === 'confirm' || type === 'prompt' || type === 'beforeunload' ? type : 'alert',
          message: String(event.params.message ?? ''),
          defaultPrompt: typeof event.params.defaultPrompt === 'string' ? event.params.defaultPrompt : null,
        });
        return;
      }
      case 'Page.javascriptDialogClosed':
        this.opts.send({ type: 'dialog-closed' });
        return;
      case 'Page.frameNavigated': {
        const frame = event.params.frame as { parentId?: string; url?: string } | undefined;
        if (frame && !frame.parentId && this.targetId) {
          const t = this.opts.instance.targets.get(this.targetId);
          this.opts.send({ type: 'url', url: frame.url ?? '', title: t?.title ?? '' });
        }
        return;
      }
    }
  }

  private async onInstanceEvent(event: BrowserInstanceEvent): Promise<void> {
    if (this.disposed) return;
    switch (event.type) {
      case 'targets': {
        this.sendTabs();
        if (this.targetId && !this.opts.instance.targets.has(this.targetId)) {
          // The selected tab closed (by us or the agent): follow another one.
          this.sessionId = null;
          this.casting = false;
          const next = [...this.opts.instance.targets.keys()][0];
          try {
            if (next) await this.selectTab(next);
            else await this.newTab();
          } catch {
            // the browser is going away; `closed` follows
          }
        } else if (this.targetId) {
          const t = this.opts.instance.targets.get(this.targetId);
          if (t) this.opts.send({ type: 'url', url: t.url, title: t.title });
        }
        return;
      }
      case 'focus':
        if (event.targetId !== this.targetId) {
          try {
            await this.selectTab(event.targetId);
          } catch {
            // the tab went away again; `targets` follows
          }
        }
        return;
      case 'navigated':
        if (event.targetId === this.targetId && this.now() - this.lastOwnActionAt > OWN_ACTION_WINDOW_MS) {
          this.opts.send({ type: 'agent-activity', url: event.url });
        }
        return;
      case 'closed':
        this.opts.send({ type: 'closed', reason: event.reason });
        this.opts.onClosed(event.reason);
        return;
    }
  }

  private sendTabs(): void {
    this.opts.send({ type: 'tabs', tabs: this.opts.service.tabsOf(this.opts.instance.id, this.targetId) });
  }
}

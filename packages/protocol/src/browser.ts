import { z } from 'zod';

/**
 * PA-178: the live browser view — a person watching and driving the shared
 * headless Chromium an agent uses, so a login, an MFA prompt or a CAPTCHA can
 * be handed to a human and back.
 *
 * The viewer speaks its own small frame protocol on its own WebSocket route
 * (`/api/browser/:id/ws`) rather than adding frames to `/api/ws`. That keeps
 * `PROTOCOL_VERSION` where it is — an older bundle never sees these frames —
 * and gives the route its own principal check: a viewer carries passwords as
 * they are typed, so it is cookie-session or hub-credential only.
 */

/** Bumped when a frame below changes shape. The client sends it as `?v=`. */
export const BROWSER_PROTOCOL_VERSION = 1;

/**
 * A browser's id *is* its scope: one shared browser (and one persistent
 * profile) per project folder and per Pocket Agent. Stable across restarts, so
 * a pushed deep link (`#/browser/<id>`) still opens the right profile after
 * the instance it was sent for has stopped.
 *
 * - `project-<16 hex>` — sha256 of the project folder's real path, truncated.
 *   The folder is the *added* folder containing a session's cwd, so every
 *   worktree and subdirectory of one project shares one login.
 * - `pocket-<plannerWorkspaceId>`.
 *
 * The server never treats this as a path: it is matched against the two
 * registries, and a value that names neither is refused.
 */
export const BROWSER_ID_PATTERN = /^(project-[0-9a-f]{16}|pocket-[A-Za-z0-9_-]{1,64})$/;
export const BrowserId = z.string().regex(BROWSER_ID_PATTERN);
export type BrowserId = z.infer<typeof BrowserId>;

export const BrowserScopeKind = z.enum(['project', 'pocket']);
export type BrowserScopeKind = z.infer<typeof BrowserScopeKind>;

export const BrowserState = z.enum(['stopped', 'starting', 'running', 'stopping']);
export type BrowserState = z.infer<typeof BrowserState>;

export const BrowserTab = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  selected: z.boolean(),
});
export type BrowserTab = z.infer<typeof BrowserTab>;

/** One scope's browser, as `GET /api/browsers` lists it. */
export const BrowserInfo = z.object({
  id: BrowserId,
  kind: BrowserScopeKind,
  /** The project folder's label or the Pocket Agent's name. */
  label: z.string(),
  state: BrowserState,
  /** Loopback CDP endpoint an agent attaches to (`playwright-cli attach --cdp=…`). Null unless running. */
  cdpUrl: z.string().nullable(),
  tabs: z.array(BrowserTab),
  /** Viewers currently attached. */
  viewers: z.number().int().nonnegative(),
  /** `request_browser_help` calls waiting on this browser. */
  pendingHelp: z.number().int().nonnegative(),
  /** Whether a profile directory exists on disk (logins persist in it). */
  hasProfile: z.boolean(),
});
export type BrowserInfo = z.infer<typeof BrowserInfo>;

export const BrowserListResponse = z.object({
  /** False when no Chromium resolves on this host, with the reason. */
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
  /**
   * Whether Chromium's renderer sandbox works on this host. Null until the
   * first launch has probed it. False is disclosed in the viewer: in a
   * container without unprivileged user namespaces the browser runs with
   * `--no-sandbox`, exactly as Playwright (and so `playwright-cli`) does.
   */
  sandbox: z.boolean().nullable(),
  browsers: z.array(BrowserInfo),
});
export type BrowserListResponse = z.infer<typeof BrowserListResponse>;

/**
 * A browser worth a row in the home screen's tree: one that is running (or
 * starting), or that an agent is waiting on. Carried by `GET /api/projects`
 * for a person's session only — never for an MCP principal.
 */
export const BrowserTreeEntry = z.object({
  id: BrowserId,
  kind: BrowserScopeKind,
  label: z.string(),
  state: BrowserState,
  pendingHelp: z.number().int().nonnegative(),
});
export type BrowserTreeEntry = z.infer<typeof BrowserTreeEntry>;

/**
 * `GET /api/browsers/:id/suggest?q=…` — the address bar's suggestions, read
 * from the profile's own Chromium history (what the agent visited included).
 */
export const BrowserSuggestion = z.object({ url: z.string(), title: z.string() });
export type BrowserSuggestion = z.infer<typeof BrowserSuggestion>;
export const BrowserSuggestResponse = z.object({ suggestions: z.array(BrowserSuggestion) });
export type BrowserSuggestResponse = z.infer<typeof BrowserSuggestResponse>;

/** `GET /api/browsers/scope?sessionId=…|plannerChatId=…` — which browser a chat would use. */
export const BrowserScopeResponse = z.object({ browser: BrowserInfo.nullable() });
export type BrowserScopeResponse = z.infer<typeof BrowserScopeResponse>;

/** `POST /api/planner/chats/:id/browser-help/:helpId`. */
export const ResolveBrowserHelpRequest = z.object({ outcome: z.enum(['done', 'cancel']) });
export type ResolveBrowserHelpRequest = z.infer<typeof ResolveBrowserHelpRequest>;

/** A pending `request_browser_help`, as the viewer shows it. */
export const BrowserHelpPending = z.object({
  helpId: z.string(),
  chatId: z.string(),
  chatTitle: z.string(),
  reason: z.string(),
});
export type BrowserHelpPending = z.infer<typeof BrowserHelpPending>;

/** Only `http(s)` may be typed into the viewer's URL bar. `file://` stays an agent-side capability. */
export function isViewerNavigableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

const Modifiers = z.number().int().min(0).max(15).optional();
const Coord = z.number().finite().min(-100_000).max(100_000);

// ---- client → server ----------------------------------------------------------

export const BrowserClientMessage = z.discriminatedUnion('type', [
  /** Page visibility and size: frames stream only while `visible`. */
  z.object({
    type: z.literal('visible'),
    visible: z.boolean(),
  }),
  /** The viewer's surface in CSS px and its device pixel ratio; the page is laid out to fit it. */
  z.object({
    type: z.literal('resize'),
    width: z.number().int().min(100).max(4000),
    height: z.number().int().min(100).max(4000),
    deviceScaleFactor: z.number().min(0.5).max(4),
    mobile: z.boolean(),
  }),
  z.object({
    type: z.literal('mouse'),
    event: z.enum(['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel']),
    x: Coord,
    y: Coord,
    button: z.enum(['none', 'left', 'middle', 'right']).optional(),
    clickCount: z.number().int().min(0).max(3).optional(),
    deltaX: Coord.optional(),
    deltaY: Coord.optional(),
    modifiers: Modifiers,
  }),
  z.object({
    type: z.literal('key'),
    event: z.enum(['keyDown', 'keyUp']),
    key: z.string().max(32),
    code: z.string().max(32),
    keyCode: z.number().int().min(0).max(255).optional(),
    text: z.string().max(4).optional(),
    modifiers: Modifiers,
  }),
  z.object({ type: z.literal('insertText'), text: z.string().min(1).max(10_000) }),
  z.object({
    type: z.literal('navigate'),
    url: z.string().max(8192).refine(isViewerNavigableUrl, 'Only http(s) addresses can be opened from the viewer.'),
  }),
  z.object({ type: z.literal('back') }),
  z.object({ type: z.literal('forward') }),
  z.object({ type: z.literal('reload') }),
  z.object({ type: z.literal('tab-select'), tabId: z.string().max(128) }),
  z.object({ type: z.literal('tab-new') }),
  z.object({ type: z.literal('tab-close'), tabId: z.string().max(128) }),
  z.object({ type: z.literal('dialog-accept'), promptText: z.string().max(10_000).optional() }),
  z.object({ type: z.literal('dialog-dismiss') }),
]);
export type BrowserClientMessage = z.infer<typeof BrowserClientMessage>;

// ---- server → client ----------------------------------------------------------

export const ScreencastMetadata = z.object({
  offsetTop: z.number(),
  pageScaleFactor: z.number(),
  deviceWidth: z.number(),
  deviceHeight: z.number(),
  scrollOffsetX: z.number(),
  scrollOffsetY: z.number(),
  timestamp: z.number().optional(),
});
export type ScreencastMetadata = z.infer<typeof ScreencastMetadata>;

export const BrowserServerMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    version: z.number().int(),
    browser: BrowserInfo,
    sandbox: z.boolean().nullable(),
  }),
  /** One JPEG frame, base64. Never logged, never persisted — a viewer shows passwords being typed. */
  z.object({ type: z.literal('frame'), data: z.string(), metadata: ScreencastMetadata }),
  z.object({ type: z.literal('tabs'), tabs: z.array(BrowserTab) }),
  z.object({ type: z.literal('url'), url: z.string(), title: z.string() }),
  z.object({
    type: z.literal('dialog'),
    dialogType: z.enum(['alert', 'confirm', 'prompt', 'beforeunload']),
    message: z.string(),
    defaultPrompt: z.string().nullable(),
  }),
  z.object({ type: z.literal('dialog-closed') }),
  /** Navigation nobody in this viewer asked for — the agent is driving too. */
  z.object({ type: z.literal('agent-activity'), url: z.string() }),
  z.object({ type: z.literal('help'), pending: z.array(BrowserHelpPending) }),
  /**
   * Whether the page's focused element takes typing, re-checked after each tap
   * and resize. A phone uses it to raise (or drop) its soft keyboard. An older
   * viewer ignores the frame, so it needed no version bump.
   */
  z.object({ type: z.literal('editable'), editable: z.boolean() }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('closed'), reason: z.string() }),
]);
export type BrowserServerMessage = z.infer<typeof BrowserServerMessage>;

/** WebSocket close codes this route uses (4000–4999 is the application range). */
export const BROWSER_CLOSE_FORBIDDEN = 4403;
export const BROWSER_CLOSE_NOT_FOUND = 4404;
export const BROWSER_CLOSE_UNAVAILABLE = 4503;
export const BROWSER_CLOSE_PROTOCOL = 4001;

import { isViewerNavigableUrl, type ScreencastMetadata } from '@pocketagent/protocol';

/**
 * PA-178: the live browser view's input rules, kept pure so they are tested
 * without a browser. A tap on the frame becomes a click at the matching page
 * coordinate; a drag becomes a scroll; the soft keyboard's text becomes
 * `insertText`; only the keys that type nothing are sent as key events.
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where on the page a point on the frame image is, in the page's CSS px. The
 * frame is the page's viewport scaled to the image, so this is a plain
 * proportion — clamped, because a pointer can leave the image mid-drag.
 */
export function framePointToPage(
  clientX: number,
  clientY: number,
  rect: Rect,
  meta: Pick<ScreencastMetadata, 'deviceWidth' | 'deviceHeight'>,
): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  const fx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const fy = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
  return { x: Math.round(fx * meta.deviceWidth * 10) / 10, y: Math.round(fy * meta.deviceHeight * 10) / 10 };
}

/** CDP's modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export function modifiersOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/** Keys that type nothing and so must be sent as key events, with their Windows key codes. */
const SPECIAL_KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
};

export interface KeyFrame {
  type: 'key';
  event: 'keyDown' | 'keyUp';
  key: string;
  code: string;
  keyCode?: number;
  text?: string;
  modifiers?: number;
}

/**
 * The key frames for one key press, or null when the key should go as text
 * instead. With Ctrl or Meta held a printable key is a shortcut (select all,
 * copy), so it is sent as a key event too; on its own it is text.
 */
export function keyFramesFor(
  key: string,
  code: string,
  modifiers: number,
): { down: KeyFrame; up: KeyFrame } | null {
  const special = SPECIAL_KEYS[key];
  const shortcut = (modifiers & 6) !== 0 && key.length === 1;
  if (!special && !shortcut) return null;
  const base = {
    type: 'key' as const,
    key,
    code: special?.code ?? (code || key),
    ...(special ? { keyCode: special.keyCode } : key.length === 1 ? { keyCode: key.toUpperCase().charCodeAt(0) } : {}),
    ...(modifiers ? { modifiers } : {}),
  };
  return {
    down: { ...base, event: 'keyDown', ...(special?.text && !shortcut ? { text: special.text } : {}) },
    up: { ...base, event: 'keyUp' },
  };
}

/** A drag of `dy` CSS px on the phone scrolls the page the same way a finger would. */
export function wheelDeltaForDrag(dy: number, deviceHeight: number, imageHeight: number): number {
  if (imageHeight <= 0) return 0;
  return Math.round(-dy * (deviceHeight / imageHeight));
}

/** The movement past which a touch is a drag (a scroll), not a tap. */
export const TAP_SLOP_PX = 8;
/** Holding this long without moving starts a real mouse drag (selecting text, a slider). */
export const LONG_PRESS_MS = 500;

/**
 * What the URL bar opens: a bare host gets `https://`, and anything that is
 * not then http(s) is refused here as well as on the server.
 */
export function normalizeTypedUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return isViewerNavigableUrl(candidate) ? candidate : null;
}

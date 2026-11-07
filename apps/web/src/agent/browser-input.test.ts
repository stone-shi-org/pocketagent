import { describe, expect, it } from 'vitest';
import {
  framePointToPage,
  keyFramesFor,
  modifiersOf,
  normalizeTypedUrl,
  resolveOmnibox,
  SEARCH_URL,
  wheelDeltaForDrag,
} from './browser-input.js';

describe('live browser view input (PA-178)', () => {
  const rect = { left: 10, top: 100, width: 375, height: 730 };
  const meta = { deviceWidth: 390, deviceHeight: 760 };

  it('maps a point on the frame to the page proportionally, clamped to the frame', () => {
    expect(framePointToPage(10, 100, rect, meta)).toEqual({ x: 0, y: 0 });
    expect(framePointToPage(10 + 375 / 2, 100 + 365, rect, meta)).toEqual({ x: 195, y: 380 });
    expect(framePointToPage(10 + 375, 100 + 730, rect, meta)).toEqual({ x: 390, y: 760 });
    expect(framePointToPage(-500, 5000, rect, meta)).toEqual({ x: 0, y: 760 });
    expect(framePointToPage(50, 50, { ...rect, width: 0 }, meta)).toEqual({ x: 0, y: 0 });
  });

  it('builds the CDP modifier mask', () => {
    expect(modifiersOf({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(0);
    expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
    expect(modifiersOf({ altKey: false, ctrlKey: true, metaKey: false, shiftKey: true })).toBe(10);
  });

  it('sends keys that type nothing as key events, and printable keys as text', () => {
    expect(keyFramesFor('a', 'KeyA', 0)).toBeNull();
    expect(keyFramesFor('é', '', 0)).toBeNull();
    const enter = keyFramesFor('Enter', 'Enter', 0)!;
    expect(enter.down).toEqual({ type: 'key', event: 'keyDown', key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
    expect(enter.up).toEqual({ type: 'key', event: 'keyUp', key: 'Enter', code: 'Enter', keyCode: 13 });
    expect(keyFramesFor('Backspace', 'Backspace', 0)!.down).not.toHaveProperty('text');
    // A shortcut is a key event, not the letter typed into the page.
    const selectAll = keyFramesFor('a', 'KeyA', 2)!;
    expect(selectAll.down).toMatchObject({ key: 'a', code: 'KeyA', keyCode: 65, modifiers: 2 });
    expect(selectAll.down).not.toHaveProperty('text');
  });

  it('scrolls the way the finger moved, scaled to the page', () => {
    expect(wheelDeltaForDrag(-100, 760, 380)).toBe(200);
    expect(wheelDeltaForDrag(50, 760, 760)).toBe(-50);
    expect(wheelDeltaForDrag(10, 760, 0)).toBe(0);
  });

  it('opens http(s) only from the URL bar, adding https:// to a bare host', () => {
    expect(normalizeTypedUrl('example.com/login')).toBe('https://example.com/login');
    expect(normalizeTypedUrl('http://127.0.0.1:9320/')).toBe('http://127.0.0.1:9320/');
    expect(normalizeTypedUrl('  ')).toBeNull();
    expect(normalizeTypedUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeTypedUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeTypedUrl('chrome://settings')).toBeNull();
  });

  it('fixes up what was typed the way an omnibox does', () => {
    expect(resolveOmnibox('github.com')).toEqual({ url: 'https://github.com', kind: 'url' });
    expect(resolveOmnibox('accounts.google.com/signin?x=1')?.url).toBe('https://accounts.google.com/signin?x=1');
    // A dev server, a router, a LAN name: plain HTTP.
    expect(resolveOmnibox('localhost:3000')).toEqual({ url: 'http://localhost:3000', kind: 'url' });
    expect(resolveOmnibox('192.168.1.1')?.url).toBe('http://192.168.1.1');
    expect(resolveOmnibox('nas.local/admin')?.url).toBe('http://nas.local/admin');
    expect(resolveOmnibox('devbox:8080')?.url).toBe('http://devbox:8080');
    // Words are a search.
    expect(resolveOmnibox('pocket agent docs')).toEqual({ url: `${SEARCH_URL}pocket%20agent%20docs`, kind: 'search' });
    expect(resolveOmnibox('weather')?.kind).toBe('search');
    expect(resolveOmnibox('what is 1.5')?.kind).toBe('search');
    // Explicit schemes are kept, and only http(s) is allowed.
    expect(resolveOmnibox('HTTP://Example.com')?.url).toBe('HTTP://Example.com');
    expect(resolveOmnibox('ftp://example.com')).toBeNull();
    expect(resolveOmnibox('about:blank')).toBeNull();
    expect(normalizeTypedUrl('localhost:3000')).toBe('http://localhost:3000');
  });
});

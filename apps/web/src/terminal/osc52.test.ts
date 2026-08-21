import { describe, expect, it } from 'vitest';
import { decodeOsc52Payload } from './osc52.js';

/** tmux (and every other OSC 52 sender) base64-encodes UTF-8 bytes. */
function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

describe('decodeOsc52Payload', () => {
  it('decodes the base64 payload after the selection letter', () => {
    expect(decodeOsc52Payload(`c;${b64('copied from tmux')}`)).toBe('copied from tmux');
  });

  it('decodes correctly regardless of which selection buffer is named', () => {
    // tmux, vim, and others use different letters ('c', 'p', 's', or several
    // at once like "cp") — a browser has exactly one clipboard, so the
    // letter itself carries no decision here.
    expect(decodeOsc52Payload(`p;${b64('primary selection')}`)).toBe('primary selection');
    expect(decodeOsc52Payload(`cp;${b64('both')}`)).toBe('both');
  });

  it('round-trips non-ASCII text instead of producing mojibake', () => {
    expect(decodeOsc52Payload(`c;${b64('héllo 👋')}`)).toBe('héllo 👋');
  });

  it('refuses a read request ("?") rather than leaking the browser clipboard', () => {
    expect(decodeOsc52Payload('c;?')).toBeNull();
  });

  it('returns null for a payload with no selection separator at all', () => {
    expect(decodeOsc52Payload('')).toBeNull();
    expect(decodeOsc52Payload('nobase64here')).toBeNull();
  });

  it('returns null rather than throwing on malformed base64', () => {
    expect(decodeOsc52Payload('c;not-valid-base64!!!')).toBeNull();
  });
});

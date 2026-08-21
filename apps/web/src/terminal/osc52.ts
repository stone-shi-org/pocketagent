/**
 * Decodes an OSC 52 ("set clipboard") payload — everything after `52;` and
 * before the terminator — into the text it is asking to be copied, or `null`
 * when there is nothing to copy.
 *
 * The payload shape is `<selection>;<base64|?>`; `<selection>` (`c`, `p`,
 * `s`, ...) says which buffer, which nothing here distinguishes since a
 * browser has exactly one clipboard. A payload of `?` is a *read* request —
 * asking the terminal to send its own clipboard contents back down to the
 * shell — and is refused outright: that direction is a real information leak
 * from whatever the user has copied elsewhere into this remote session, and
 * every other web terminal that supports OSC 52 only implements the write
 * direction for the same reason.
 *
 * Deliberately its own module rather than living in `create-terminal.ts`:
 * that file imports `@xterm/xterm` and its addons, whose bundles assume a
 * browser global at module-load time and cannot be imported under this
 * repo's plain-Node vitest environment — keeping this pure function apart
 * from that import is what makes it unit-testable at all.
 */
export function decodeOsc52Payload(data: string): string | null {
  const separator = data.indexOf(';');
  const payload = separator === -1 ? '' : data.slice(separator + 1);
  if (!payload || payload === '?') return null;
  try {
    // atob yields a binary string (one code unit per byte); the actual text
    // is UTF-8, so it has to be re-decoded through TextDecoder, or anything
    // outside ASCII copies as mojibake.
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null; // Malformed base64 from whatever sent it.
  }
}

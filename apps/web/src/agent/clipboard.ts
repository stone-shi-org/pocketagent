/**
 * Copy text, including where the modern clipboard API is unavailable.
 *
 * `navigator.clipboard` only exists in a *secure context*: HTTPS, or localhost.
 * PocketAgent is routinely served over plain HTTP on a LAN or tailnet address,
 * and on that origin the property is simply undefined — so a copy button built
 * on it alone would be dead on exactly the deployment this app is written for.
 *
 * The fallback is the pre-2018 trick: a throwaway textarea, selected, then
 * `execCommand('copy')`. It is deprecated and it is ugly, but it works in a
 * non-secure context and it is the only thing that does.
 */

export interface ClipboardDeps {
  /** The async clipboard, when the context allows it. */
  write: ((text: string) => Promise<void>) | null;
  /** Synchronous selection-based copy. Returns false if it did not take. */
  legacy: ((text: string) => boolean) | null;
}

export async function copyText(
  text: string,
  deps: ClipboardDeps = browserDeps(),
): Promise<boolean> {
  if (!text) return false;

  if (deps.write) {
    try {
      await deps.write(text);
      return true;
    } catch {
      // Permission denied, or a context that lies about being secure. Fall
      // through rather than reporting failure while a working path remains.
    }
  }

  return deps.legacy ? deps.legacy(text) : false;
}

function browserDeps(): ClipboardDeps {
  const write =
    typeof navigator !== 'undefined' && navigator.clipboard
      ? (text: string) => navigator.clipboard.writeText(text)
      : null;
  return { write, legacy: typeof document !== 'undefined' ? legacyCopy : null };
}

function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  // Off-screen rather than hidden: a display:none element cannot be selected,
  // and scrolling the page to a focused field would jump the transcript.
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);

  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(area);
    // Put the user's own selection back; copying should not clear it.
    if (previous && selection) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
  }
}

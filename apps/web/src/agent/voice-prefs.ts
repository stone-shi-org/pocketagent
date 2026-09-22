/**
 * Browser preference: whether push-to-talk voice input should be sent
 * immediately upon recording completion, or inserted into the prompt box
 * for review and manual sending (PA-82).
 *
 * Stored in `localStorage` per-device, defaulting to false (review mode).
 */
const KEY = 'pocketagent:voice-direct-send';

export function getVoiceDirectSendPref(): boolean {
  try {
    return localStorage.getItem(KEY) === 'true';
  } catch {
    return false;
  }
}

export function setVoiceDirectSendPref(value: boolean): void {
  try {
    if (value) {
      localStorage.setItem(KEY, 'true');
    } else {
      localStorage.removeItem(KEY);
    }
  } catch {
    /* private browsing or storage disabled */
  }
}

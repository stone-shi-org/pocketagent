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

/**
 * Browser preference: user-selected microphone device ID for push-to-talk
 * and hands-free live stream audio capture (PA-94).
 * Empty string indicates system default device.
 */
const MIC_DEVICE_ID_KEY = 'pocketagent:voice-mic-device-id';

export function getVoiceMicDeviceIdPref(): string {
  try {
    return localStorage.getItem(MIC_DEVICE_ID_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setVoiceMicDeviceIdPref(deviceId: string): void {
  try {
    const trimmed = deviceId.trim();
    if (trimmed) {
      localStorage.setItem(MIC_DEVICE_ID_KEY, trimmed);
    } else {
      localStorage.removeItem(MIC_DEVICE_ID_KEY);
    }
  } catch {
    /* private browsing or storage disabled */
  }
}


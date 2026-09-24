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

/**
 * Browser preference: whether Gemini Live hands-free live stream is enabled
 * for Pocket Agent chats (PA-98).
 */
const GEMINI_LIVE_KEY = 'pocketagent:gemini-live-enabled';

export function getGeminiLivePref(chatId?: string): boolean {
  try {
    if (chatId) {
      const perChat = localStorage.getItem(`${GEMINI_LIVE_KEY}:${chatId}`);
      if (perChat !== null) return perChat === 'true';
    }
    return localStorage.getItem(GEMINI_LIVE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setGeminiLivePref(value: boolean, chatId?: string): void {
  try {
    const str = value ? 'true' : 'false';
    localStorage.setItem(GEMINI_LIVE_KEY, str);
    if (chatId) {
      localStorage.setItem(`${GEMINI_LIVE_KEY}:${chatId}`, str);
    }
  } catch {
    /* private browsing or storage disabled */
  }
}


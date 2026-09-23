import { useCallback, useEffect, useState } from 'react';
import { getVoiceMicDeviceIdPref, setVoiceMicDeviceIdPref } from '../agent/voice-prefs.js';

export interface AudioInputDevice {
  deviceId: string;
  label: string;
  groupId?: string;
}

export const MIC_CHANGE_EVENT = 'pocketagent:mic-device-changed';

/**
 * Returns all audio input devices detected by the browser.
 * Safe to call in test/SSR environments.
 */
export async function getAudioInputDevices(): Promise<AudioInputDevice[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return [];
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((d) => d.kind === 'audioinput');
    const seen = new Set<string>();
    const result: AudioInputDevice[] = [];

    for (const d of audioInputs) {
      // Skip duplicate device IDs if any
      if (seen.has(d.deviceId)) continue;
      seen.add(d.deviceId);

      result.push({
        deviceId: d.deviceId,
        label: d.label || (d.deviceId ? `Microphone ${result.length + 1}` : 'Default Microphone'),
        ...(d.groupId ? { groupId: d.groupId } : {}),
      });
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * Prompts for microphone access if device labels are blank (which browsers do
 * until permission is granted on the origin), then re-enumerates devices.
 */
export async function requestMicPermissionAndEnumerate(): Promise<AudioInputDevice[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return [];
  }
  let devices = await getAudioInputDevices();
  const needsPermission = devices.some((d) => !d.label || d.label.startsWith('Microphone '));
  if (needsPermission && typeof navigator.mediaDevices.getUserMedia === 'function') {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) {
        track.stop();
      }
      devices = await getAudioInputDevices();
    } catch {
      // Permission denied or dismissed; proceed with existing device list
    }
  }
  return devices;
}

/**
 * React hook to enumerate audio input devices, observe changes (device connect/disconnect),
 * and track/update the selected microphone preference across the app (PA-94).
 */
export function useAudioInputDevices(): {
  devices: AudioInputDevice[];
  selectedDeviceId: string;
  selectDevice: (deviceId: string) => void;
  refresh: () => Promise<void>;
} {
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(() => getVoiceMicDeviceIdPref());

  const refresh = useCallback(async () => {
    const list = await getAudioInputDevices();
    setDevices(list);
  }, []);

  useEffect(() => {
    void refresh();

    const onDeviceChange = (): void => {
      void refresh();
    };

    const onPrefChange = (event: Event): void => {
      if (event instanceof CustomEvent && typeof event.detail === 'string') {
        setSelectedDeviceId(event.detail);
      } else {
        setSelectedDeviceId(getVoiceMicDeviceIdPref());
      }
    };

    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener(MIC_CHANGE_EVENT, onPrefChange);
      window.addEventListener('storage', onPrefChange);
    }

    return () => {
      if (typeof navigator !== 'undefined' && navigator.mediaDevices?.removeEventListener) {
        navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener(MIC_CHANGE_EVENT, onPrefChange);
        window.removeEventListener('storage', onPrefChange);
      }
    };
  }, [refresh]);

  const selectDevice = useCallback((deviceId: string) => {
    const trimmed = deviceId.trim();
    setSelectedDeviceId(trimmed);
    setVoiceMicDeviceIdPref(trimmed);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(MIC_CHANGE_EVENT, { detail: trimmed }));
    }
  }, []);

  return { devices, selectedDeviceId, selectDevice, refresh };
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAudioInputDevices, requestMicPermissionAndEnumerate } from './devices.js';

describe('audio input devices enumeration (PA-94)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns empty array when navigator.mediaDevices is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const devices = await getAudioInputDevices();
    expect(devices).toEqual([]);
  });

  it('filters only audioinput devices and formats labels', async () => {
    const fakeDevices = [
      { deviceId: 'mic-1', kind: 'audioinput', label: 'Built-in Microphone' },
      { deviceId: 'speaker-1', kind: 'audiooutput', label: 'Built-in Speaker' },
      { deviceId: 'cam-1', kind: 'videoinput', label: 'Webcam' },
      { deviceId: 'mic-2', kind: 'audioinput', label: 'USB Headset Mic' },
    ];
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue(fakeDevices),
      },
    });

    const devices = await getAudioInputDevices();
    expect(devices).toHaveLength(2);
    expect(devices[0]).toEqual({ deviceId: 'mic-1', label: 'Built-in Microphone' });
    expect(devices[1]).toEqual({ deviceId: 'mic-2', label: 'USB Headset Mic' });
  });

  it('falls back to indexed label when device label is empty', async () => {
    const fakeDevices = [
      { deviceId: 'mic-1', kind: 'audioinput', label: '' },
      { deviceId: 'mic-2', kind: 'audioinput', label: '' },
    ];
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue(fakeDevices),
      },
    });

    const devices = await getAudioInputDevices();
    expect(devices).toHaveLength(2);
    expect(devices[0]).toEqual({ deviceId: 'mic-1', label: 'Microphone 1' });
    expect(devices[1]).toEqual({ deviceId: 'mic-2', label: 'Microphone 2' });
  });

  it('deduplicates devices with identical deviceIds', async () => {
    const fakeDevices = [
      { deviceId: 'mic-1', kind: 'audioinput', label: 'Default Mic' },
      { deviceId: 'mic-1', kind: 'audioinput', label: 'Duplicate Mic' },
    ];
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValue(fakeDevices),
      },
    });

    const devices = await getAudioInputDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]!.deviceId).toBe('mic-1');
  });

  it('requestMicPermissionAndEnumerate prompts getUserMedia if labels are blank', async () => {
    let permissionGranted = false;
    const stopMock = vi.fn();
    const fakeStream = {
      getTracks: () => [{ stop: stopMock }],
    };

    const enumerateDevicesMock = vi.fn().mockImplementation(async () => {
      if (!permissionGranted) {
        return [{ deviceId: 'mic-1', kind: 'audioinput', label: '' }];
      }
      return [{ deviceId: 'mic-1', kind: 'audioinput', label: 'External USB Mic' }];
    });

    const getUserMediaMock = vi.fn().mockImplementation(async () => {
      permissionGranted = true;
      return fakeStream;
    });

    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: enumerateDevicesMock,
        getUserMedia: getUserMediaMock,
      },
    });

    const devices = await requestMicPermissionAndEnumerate();
    expect(getUserMediaMock).toHaveBeenCalledWith({ audio: true });
    expect(stopMock).toHaveBeenCalled();
    expect(devices).toHaveLength(1);
    expect(devices[0]!.label).toBe('External USB Mic');
  });
});

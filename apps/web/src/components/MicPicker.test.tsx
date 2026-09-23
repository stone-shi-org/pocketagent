import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MicPicker } from './MicPicker.js';

describe('MicPicker component (PA-94)', () => {
  const devices = [
    { deviceId: 'mic-builtin', label: 'Built-in Mic' },
    { deviceId: 'mic-usb', label: 'USB Podcast Mic' },
  ];

  it('renders default system mic and enumerated devices', () => {
    const html = renderToStaticMarkup(
      <MicPicker
        devices={devices}
        selectedDeviceId=""
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );

    expect(html).toContain('Default (System default)');
    expect(html).toContain('Built-in Mic');
    expect(html).toContain('USB Podcast Mic');
  });

  it('highlights the selected device', () => {
    const html = renderToStaticMarkup(
      <MicPicker
        devices={devices}
        selectedDeviceId="mic-usb"
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );

    expect(html).toContain('USB Podcast Mic');
    expect(html).toContain('class="active"');
  });

  it('shows disconnected device fallback when selected device is not found', () => {
    const html = renderToStaticMarkup(
      <MicPicker
        devices={devices}
        selectedDeviceId="unplugged-device"
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );

    expect(html).toContain('Disconnected device');
  });
});

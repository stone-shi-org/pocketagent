import { useEffect, useRef } from 'react';
import { Icon } from './Icon.js';
import type { AudioInputDevice } from '../audio/devices.js';

export interface MicPickerProps {
  devices: AudioInputDevice[];
  selectedDeviceId: string;
  onSelect: (deviceId: string) => void;
  onClose: () => void;
  /** Anchor alignment: 'left' (default) or 'right'. */
  align?: 'left' | 'right';
}

/**
 * Microphone selection popover (PA-94).
 * Allows switching audio input devices for push-to-talk and live stream.
 */
export function MicPicker({
  devices,
  selectedDeviceId,
  onSelect,
  onClose,
  align = 'left',
}: MicPickerProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent | TouchEvent): void {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const hasSelectedInList = !selectedDeviceId || devices.some((d) => d.deviceId === selectedDeviceId);

  return (
    <div
      className={align === 'right' ? 'mic-picker align-right' : 'mic-picker'}
      role="listbox"
      aria-label="Microphone input device"
      ref={ref}
    >
      <div className="mic-picker-header">
        <Icon name="mic" size={13} />
        <span>Microphone</span>
      </div>
      <button
        type="button"
        className={!selectedDeviceId ? 'active' : ''}
        onClick={() => {
          onSelect('');
          onClose();
        }}
        role="option"
        aria-selected={!selectedDeviceId}
      >
        <div className="mic-row">
          <span className="mic-name">Default (System default)</span>
          {!selectedDeviceId && <Icon name="check" size={14} />}
        </div>
      </button>

      {devices.map((device) => {
        const isSelected = selectedDeviceId === device.deviceId;
        return (
          <button
            key={device.deviceId}
            type="button"
            className={isSelected ? 'active' : ''}
            onClick={() => {
              onSelect(device.deviceId);
              onClose();
            }}
            role="option"
            aria-selected={isSelected}
          >
            <div className="mic-row">
              <span className="mic-name">{device.label}</span>
              {isSelected && <Icon name="check" size={14} />}
            </div>
          </button>
        );
      })}

      {!hasSelectedInList && (
        <button
          type="button"
          className="active disconnected"
          onClick={() => {
            onSelect('');
            onClose();
          }}
          role="option"
          aria-selected={true}
          title="Previously selected microphone is disconnected. Click to reset to default."
        >
          <div className="mic-row">
            <span className="mic-name">Disconnected device</span>
            <Icon name="check" size={14} />
          </div>
        </button>
      )}
    </div>
  );
}

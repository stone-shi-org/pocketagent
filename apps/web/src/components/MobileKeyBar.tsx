import { useState } from 'react';

/**
 * Sequences the on-screen keys emit. These are exactly the bytes a physical
 * terminal sends, so the CLI cannot tell the difference between these buttons
 * and a keyboard.
 */
export const KEY_SEQUENCES = {
  escape: '\x1b',
  tab: '\t',
  enter: '\r',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  ctrlC: '\x03',
  ctrlD: '\x04',
  ctrlZ: '\x1a',
  ctrlL: '\x0c',
  ctrlR: '\x12',
  shiftTab: '\x1b[Z',
} as const;

/** Ctrl+<letter> is the letter's position in the alphabet as a control code. */
export function ctrlSequence(key: string): string | null {
  const lower = key.toLowerCase();
  if (lower.length !== 1) return null;
  const code = lower.charCodeAt(0);
  if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
  if (key === '[') return '\x1b';
  if (key === '\\') return '\x1c';
  if (key === ']') return '\x1d';
  return null;
}

interface Props {
  onSend: (data: string) => void;
  /** True while the Ctrl modifier is latched for the next keypress. */
  ctrlActive: boolean;
  onToggleCtrl: () => void;
  disabled: boolean;
}

export function MobileKeyBar({ onSend, ctrlActive, onToggleCtrl, disabled }: Props): JSX.Element {
  const [showMore, setShowMore] = useState(false);

  const key = (label: string, sequence: string, aria?: string): JSX.Element => (
    <button
      type="button"
      key={label}
      disabled={disabled}
      aria-label={aria ?? label}
      // pointerDown rather than click: the terminal must not lose focus, and it
      // makes repeated arrow taps feel immediate.
      onPointerDown={(e) => {
        e.preventDefault();
        onSend(sequence);
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="keybar" role="toolbar" aria-label="Terminal keys">
      {key('Esc', KEY_SEQUENCES.escape)}
      <button
        type="button"
        className={ctrlActive ? 'active' : ''}
        disabled={disabled}
        aria-pressed={ctrlActive}
        onPointerDown={(e) => {
          e.preventDefault();
          onToggleCtrl();
        }}
      >
        Ctrl
      </button>
      {key('^C', KEY_SEQUENCES.ctrlC, 'Control C')}
      {key('Tab', KEY_SEQUENCES.tab)}
      {key('↑', KEY_SEQUENCES.up, 'Up arrow')}
      {key('↓', KEY_SEQUENCES.down, 'Down arrow')}
      {key('←', KEY_SEQUENCES.left, 'Left arrow')}
      {key('→', KEY_SEQUENCES.right, 'Right arrow')}
      {key('⏎', KEY_SEQUENCES.enter, 'Enter')}
      <button
        type="button"
        onPointerDown={(e) => {
          e.preventDefault();
          setShowMore((v) => !v);
        }}
        aria-expanded={showMore}
      >
        {showMore ? '«' : '»'}
      </button>
      {showMore && (
        <>
          {key('⌫', KEY_SEQUENCES.backspace, 'Backspace')}
          {key('⇧Tab', KEY_SEQUENCES.shiftTab, 'Shift Tab')}
          {key('^D', KEY_SEQUENCES.ctrlD, 'Control D')}
          {key('^Z', KEY_SEQUENCES.ctrlZ, 'Control Z')}
          {key('^L', KEY_SEQUENCES.ctrlL, 'Control L')}
          {key('^R', KEY_SEQUENCES.ctrlR, 'Control R')}
          {key('1', '1')}
          {key('2', '2')}
          {key('3', '3')}
          {key('y', 'y')}
          {key('n', 'n')}
        </>
      )}
    </div>
  );
}

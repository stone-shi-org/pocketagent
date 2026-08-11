import { useEffect, useRef, useState } from 'react';

export interface SelectorOption {
  value: string;
  label: string;
  detail?: string;
  disabled?: boolean;
}

interface Props {
  /** Single glyph shown on the left. Kept as text so there is no icon font. */
  icon: string;
  label: string;
  value: string;
  options: SelectorOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
}

/**
 * One line of the composer: an icon, the current choice, and a stepper glyph.
 *
 * Tapping opens a sheet rather than stepping to the next value. The stepper
 * look comes from the design being mimicked, but blind cycling on a phone means
 * you cannot see what you are about to pick, and with one option — which is the
 * case for the host today — it would do nothing at all.
 */
export function SelectorRow({
  icon,
  label,
  value,
  options,
  onChange,
  ariaLabel,
}: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  const only = options.length <= 1;

  return (
    <>
      <button
        type="button"
        className="selector-row"
        onClick={() => !only && setOpen(true)}
        aria-label={`${ariaLabel}: ${current?.label ?? value}`}
        aria-haspopup={only ? undefined : 'listbox'}
        data-selector={label}
      >
        <span className="selector-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="selector-value">{current?.label ?? value}</span>
        {!only && (
          <span className="selector-chevron" aria-hidden="true">
            ⌃⌄
          </span>
        )}
      </button>

      {open && (
        <PickerSheet
          title={label}
          value={value}
          options={options}
          onPick={(next) => {
            setOpen(false);
            if (next !== value) onChange(next);
          }}
          onCancel={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function PickerSheet({
  title,
  value,
  options,
  onPick,
  onCancel,
}: {
  title: string;
  value: string | null;
  options: SelectorOption[];
  onPick: (value: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  // Escape closes, and focus moves into the sheet so a keyboard can reach it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="sheet-backdrop" onClick={onCancel} role="presentation">
      <div
        className="sheet"
        ref={ref}
        onClick={(e) => e.stopPropagation()}
        role="listbox"
        aria-label={title}
      >
        <div className="sheet-title">{title}</div>
        <div className="sheet-options">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`sheet-option${option.value === value ? ' selected' : ''}`}
              disabled={option.disabled}
              onClick={() => onPick(option.value)}
            >
              <span className="sheet-option-label">{option.label}</span>
              {option.detail && <span className="sheet-option-detail">{option.detail}</span>}
            </button>
          ))}
        </div>
        <button type="button" className="sheet-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

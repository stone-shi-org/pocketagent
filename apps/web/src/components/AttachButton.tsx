import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.js';

const ACCEPT = 'image/jpeg,image/png,image/gif,image/webp';

interface Props {
  /** A file the user picked from the menu's "Add photos & files" item. */
  onFile: (file: File) => void;
  disabled?: boolean;
}

/**
 * The "+" attach trigger, shared between `PromptBox` (a live chat) and
 * `ComposerPage` (starting one).
 *
 * A click opens a small popup menu rather than the file picker directly —
 * the same shape most web chat UIs use for this button, and the point of it:
 * today the menu has exactly one item ("Add photos & files"), but nothing
 * about the trigger has to change to add "Add from library" or anything else
 * later, only another row here.
 */
export function AttachButton({ onFile, disabled = false }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Same outside-click/Escape dismissal as PromptBox's own model picker —
  // a document-level listener so Escape works regardless of what currently
  // has focus, not just while the trigger button itself does.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }
    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ''; // lets the same file be picked again later
          if (file) onFile(file);
        }}
      />
      <button
        type="button"
        className="attach-btn"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Add photos & files"
        ref={triggerRef}
      >
        <Icon name="plus" size={19} />
      </button>
      {open && (
        <div className="attach-menu" role="menu" ref={menuRef}>
          <button
            type="button"
            role="menuitem"
            onMouseDown={(e) => {
              // mousedown, not click — same reasoning as PromptBox's slash
              // picker: fires before the textarea's own blur, so the tap
              // registers instead of the menu vanishing first.
              e.preventDefault();
              setOpen(false);
              fileInputRef.current?.click();
            }}
          >
            <Icon name="attach" size={17} />
            <span className="attach-menu-text">
              <span className="attach-menu-title">Add photos &amp; files</span>
              <span className="attach-menu-detail">Upload from this device</span>
            </span>
          </button>
        </div>
      )}
    </>
  );
}

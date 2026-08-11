/**
 * The icon set, inline.
 *
 * No icon font and no sprite sheet: a dozen paths cost less than either, they
 * inherit `currentColor` so a disabled or pressed state needs no second asset,
 * and they cannot arrive late and reflow the layout the way a font does.
 *
 * All are drawn on a 24px grid with a 1.7 stroke and round caps, which is what
 * makes them read as one family rather than a pile of clip art.
 */

export type IconName =
  | 'folder'
  | 'chevron-down'
  | 'chevron-left'
  | 'compose'
  | 'terminal'
  | 'search'
  | 'bell'
  | 'bell-off'
  | 'ellipsis'
  | 'stepper'
  | 'arrow-up'
  | 'laptop'
  | 'branch'
  | 'close';

interface Props {
  name: IconName;
  /** Pixel size of the square box. Stroke stays visually constant. */
  size?: number;
  className?: string;
}

export function Icon({ name, size = 22, className }: Props): JSX.Element {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

const PATHS: Record<IconName, JSX.Element> = {
  // Slightly open folder, as in the reference.
  folder: (
    <>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2a1.5 1.5 0 0 1 1.1.5l1 1.1a1.5 1.5 0 0 0 1.1.5h6.6A1.5 1.5 0 0 1 20 9.6" />
      <path d="M3 7.6v9.9A1.5 1.5 0 0 0 4.5 19h13.2a1.5 1.5 0 0 0 1.45-1.1l1.6-6A1.2 1.2 0 0 0 19.6 10.4H6.3a1.5 1.5 0 0 0-1.45 1.1L3 18" />
    </>
  ),

  'chevron-down': <path d="M6 9.5 12 15.5 18 9.5" />,

  'chevron-left': <path d="M14.5 5 8 12l6.5 7" />,

  // Square with a pencil: "write something here".
  compose: (
    <>
      <path d="M18.5 13.2V18a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 18V8A2.5 2.5 0 0 1 6 5.5h4.8" />
      <path d="M16.4 3.9a1.9 1.9 0 0 1 2.7 2.7l-7.2 7.2-3.4.7.7-3.4Z" />
    </>
  ),

  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M7.5 9.5 10.5 12l-3 2.5" />
      <path d="M13 15h4" />
    </>
  ),

  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),

  bell: (
    <>
      <path d="M18 9a6 6 0 1 0-12 0c0 4.5-1.5 6-1.5 6h15S18 13.5 18 9Z" />
      <path d="M13.7 18.5a2 2 0 0 1-3.4 0" />
    </>
  ),

  'bell-off': (
    <>
      <path d="M18 9a6 6 0 0 0-9.3-5" />
      <path d="M6.1 6.6A6 6 0 0 0 6 9c0 4.5-1.5 6-1.5 6h12" />
      <path d="M13.7 18.5a2 2 0 0 1-3.4 0" />
      <path d="m3.5 3.5 17 17" />
    </>
  ),

  ellipsis: (
    <>
      <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),

  // Up/down pair: the affordance the reference uses for "this is selectable".
  stepper: (
    <>
      <path d="M8.5 10 12 6.5 15.5 10" />
      <path d="M8.5 14 12 17.5 15.5 14" />
    </>
  ),

  'arrow-up': (
    <>
      <path d="M12 19V5.5" />
      <path d="m6 11.5 6-6 6 6" />
    </>
  ),

  laptop: (
    <>
      <rect x="4" y="5" width="16" height="11" rx="1.8" />
      <path d="M2.5 19.5h19" />
    </>
  ),

  branch: (
    <>
      <circle cx="7" cy="6" r="2.2" />
      <circle cx="7" cy="18" r="2.2" />
      <circle cx="17" cy="9" r="2.2" />
      <path d="M7 8.2v7.6" />
      <path d="M17 11.2c0 3-2.4 4.3-5 4.6" />
    </>
  ),

  close: <path d="m6 6 12 12M18 6 6 18" />,
};

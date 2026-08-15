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
  | 'stop'
  | 'laptop'
  | 'branch'
  | 'copy'
  | 'check'
  | 'close'
  | 'attach'
  | 'agents'
  | 'agent-claude'
  | 'agent-codex'
  | 'agent-agy'
  | 'agent-opencode'
  | 'agent-pi'
  | 'agent-shell'
  | 'agent-generic';

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

  // A filled square: the universal "stop" glyph, distinct in silhouette from
  // `arrow-up` (not just recolored) since the send button swaps between the
  // two live while an agent is generating — see PromptBox.tsx.
  stop: <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />,

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

  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2.2" />
      <path d="M15 6.5A2.5 2.5 0 0 0 12.5 4H6.5A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15" />
    </>
  ),

  check: <path d="m5 12.5 4.5 4.5L19 7" />,

  close: <path d="m6 6 12 12M18 6 6 18" />,

  // A paperclip: "attach a file" — used for the prompt box's image attach
  // button, so it reads distinctly from `compose`'s pencil-in-square.
  attach: (
    <path d="M16.5 6.5v9a4 4 0 0 1-8 0v-10a2.5 2.5 0 0 1 5 0v9a1 1 0 0 1-2 0v-8" />
  ),

  // Two overlapping cards with a pair of eyes on the front one: "a fleet",
  // not one agent — distinct from `branch`'s three-node graph, which is
  // about lineage rather than a set of running things.
  agents: (
    <>
      <rect x="3" y="7" width="12" height="10" rx="2.5" />
      <rect x="9" y="4" width="12" height="10" rx="2.5" />
      <circle cx="13.3" cy="9" r="1" fill="currentColor" stroke="none" />
      <circle cx="17.3" cy="9" r="1" fill="currentColor" stroke="none" />
    </>
  ),

  // Mascots, one per agent id (`apps/server/src/agents/registry.ts`). Simple
  // distinguishing motifs in the same stroke family, not literal art — a
  // fleet card needs to tell agent types apart at a glance, not illustrate
  // them.
  'agent-claude': (
    <>
      <rect x="4" y="4" width="16" height="16" rx="5" />
      <path d="M12 8v8M8.5 9.5l7 5M15.5 9.5l-7 5" />
    </>
  ),

  'agent-codex': (
    <>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M9 7V4M12 7V4M15 7V4M9 20v-3M12 20v-3M15 20v-3M7 9H4M7 12H4M7 15H4M20 9h-3M20 12h-3M20 15h-3" />
    </>
  ),

  // Antigravity CLI: a rocket lifting off.
  'agent-agy': (
    <>
      <path d="M12 3c2.5 2 3.5 5.5 3.5 8.5 0 2-1 4-3.5 6-2.5-2-3.5-4-3.5-6C8.5 8.5 9.5 5 12 3Z" />
      <circle cx="12" cy="9" r="1.2" />
      <path d="M8.5 13.5 6 16M15.5 13.5 18 16M10.5 17.5 9.5 20.5M13.5 17.5 14.5 20.5" />
    </>
  ),

  // A face made of `<` `>`, for the agent whose name is literally "open code".
  'agent-opencode': (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.5 9 7 12l2.5 3M14.5 9 17 12l-2.5 3" />
    </>
  ),

  // A π glyph with two eyes above it — the agent is named after the symbol.
  'agent-pi': (
    <>
      <circle cx="9.3" cy="6.7" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.7" cy="6.7" r="1" fill="currentColor" stroke="none" />
      <path d="M7 10h10M9.5 10v7.5M14.5 10c0 3-.3 5.5-1 7.5" />
    </>
  ),

  // A literal shell (nautilus spiral), for the plain shell/terminal agent.
  'agent-shell': (
    <>
      <path d="M12 19c-4 0-6-2.5-6-6 0-3 2-5 5-5 2.4 0 4 1.6 4 3.8 0 1.8-1.2 3-2.8 3-1.4 0-2.4-1-2.4-2.3 0-1 .8-1.7 1.7-1.7" />
      <path d="M4 19h16" />
    </>
  ),

  // Fallback for an agent id the client does not specifically recognize —
  // a plain robot head, since the registry can grow without a client update.
  'agent-generic': (
    <>
      <rect x="5" y="6" width="14" height="12" rx="3" />
      <circle cx="9.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <path d="M12 3v3" />
      <circle cx="12" cy="2.4" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
};

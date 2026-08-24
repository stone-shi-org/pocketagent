import { useRef, useState } from 'react';
import { Icon } from './Icon.js';

export interface Tab {
  id: string;
  title: string;
  /** Shows the same live-dot the sidebar uses — a tab is its title and,
      if running, a green dot, same as a chat row. */
  live: boolean;
}

interface Props {
  tabs: Tab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** Called once, on pointer up, with the full reordered id list. */
  onReorder: (orderedIds: string[]) => void;
}

/**
 * The desktop workspace's browser-style tab strip.
 *
 * Purely presentational — `DesktopShell` owns which sessions are open, which
 * one is active, and what happens when one closes. This only renders the
 * strip and reports gestures back up.
 *
 * Reordering uses pointer events with `setPointerCapture`, the same approach
 * `ApprovalSheet`'s drag handle uses, rather than the native HTML5 `draggable`
 * API — that fights touch scroll and image dragging. Each move re-measures
 * every tab's current on-screen position and re-derives the insertion point
 * from the pointer's x — simple enough for a strip with a handful of tabs,
 * and self-correcting since the next move always reads freshly rendered
 * positions rather than trusting stale ones.
 */
export function TabBar({ tabs, activeId, onSelect, onClose, onReorder }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragId = useRef<string | null>(null);
  const [liveOrder, setLiveOrder] = useState<string[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const order = liveOrder ?? tabs.map((t) => t.id);
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const ordered = order.map((id) => byId.get(id)).filter((t): t is Tab => t !== undefined);

  function startDrag(e: React.PointerEvent<HTMLDivElement>, id: string): void {
    // A click on the close button lands here first (it's inside the tab); let
    // it through as a click instead of arming a drag.
    if ((e.target as HTMLElement).closest('button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragId.current = id;
    setDraggingId(id);
  }

  function drag(e: React.PointerEvent<HTMLDivElement>): void {
    const id = dragId.current;
    const container = containerRef.current;
    if (!id || !container) return;
    const items = Array.from(container.querySelectorAll<HTMLElement>('[data-tab-id]'));
    const ids = items.map((el) => el.dataset.tabId as string);
    const fromIndex = ids.indexOf(id);
    if (fromIndex === -1) return;
    let toIndex = items.length - 1;
    for (const [i, item] of items.entries()) {
      const rect = item.getBoundingClientRect();
      if (e.clientX < rect.left + rect.width / 2) {
        toIndex = i;
        break;
      }
    }
    if (toIndex === fromIndex) return;
    const next = ids.slice();
    next.splice(fromIndex, 1);
    next.splice(toIndex, 0, id);
    setLiveOrder(next);
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>): void {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragId.current = null;
    setDraggingId(null);
    if (liveOrder) onReorder(liveOrder);
    setLiveOrder(null);
  }

  return (
    <div className="tab-bar" ref={containerRef} role="tablist">
      {ordered.map((tab) => (
        <div
          key={tab.id}
          data-tab-id={tab.id}
          role="tab"
          aria-selected={tab.id === activeId}
          className={[
            'tab',
            tab.id === activeId ? 'active' : '',
            tab.id === draggingId ? 'dragging' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onPointerDown={(e) => startDrag(e, tab.id)}
          onPointerMove={drag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onClick={() => onSelect(tab.id)}
          title={tab.title}
        >
          {tab.live && <span className="live-dot" aria-label="running" />}
          <span className="tab-title">{tab.title}</span>
          <button
            type="button"
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation();
              onClose(tab.id);
            }}
            aria-label={`Close ${tab.title}`}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

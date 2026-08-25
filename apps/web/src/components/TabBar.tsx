import { useEffect, useRef, useState } from 'react';
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
  /** Right-click menu: "Close All". */
  onCloseAll: () => void;
  /** Right-click menu: "Close all except this one" — called with the id of
      the tab that was right-clicked. */
  onCloseOthers: (keepId: string) => void;
}

/** Where a tab's right-click menu opens, and which tab it's for. */
interface ContextMenuState {
  tabId: string;
  x: number;
  y: number;
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
export function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onReorder,
  onCloseAll,
  onCloseOthers,
}: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const listTriggerRef = useRef<HTMLButtonElement>(null);
  const dragId = useRef<string | null>(null);
  const [liveOrder, setLiveOrder] = useState<string[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Position, not just a boolean: both this and the right-click menu below
  // render `position: fixed` at explicit viewport coordinates rather than
  // `position: absolute` anchored to a relative ancestor — `.tab-bar` clips
  // its own overflow (see its doc comment) and `.workspace` above it does
  // too, so an absolutely-positioned popup nested inside either would render
  // and then immediately vanish, clipped before it could ever be seen.
  const [listMenuAt, setListMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const order = liveOrder ?? tabs.map((t) => t.id);
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const ordered = order.map((id) => byId.get(id)).filter((t): t is Tab => t !== undefined);

  function toggleTabList(): void {
    if (listMenuAt) {
      setListMenuAt(null);
      return;
    }
    const rect = listTriggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setListMenuAt({ x: rect.left, y: rect.bottom });
  }

  // Same Escape-to-close as `ProjectMenu`/`OverflowMenu`, shared across
  // whichever of the two popups (tab list, right-click menu) is open.
  useEffect(() => {
    if (!listMenuAt && !contextMenu) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return;
      setListMenuAt(null);
      setContextMenu(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [listMenuAt, contextMenu]);

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
    <>
      <div className="tab-bar" ref={containerRef} role="tablist">
        {/* Chrome's own "search tabs" chevron: a fixed-width dropdown ahead of
            the (shrinking) tab strip, listing every open tab regardless of
            whether it currently has room to show its own label. */}
        <div className="tab-list-dropdown">
          <button
            type="button"
            ref={listTriggerRef}
            className="tab-list-trigger"
            onClick={toggleTabList}
            aria-label="List all tabs"
            aria-haspopup="menu"
            aria-expanded={listMenuAt !== null}
          >
            <Icon name="chevron-down" size={14} />
          </button>
          {listMenuAt && (
            <>
              <div className="menu-backdrop" onClick={() => setListMenuAt(null)} role="presentation" />
              <div
                className="menu tab-list-menu"
                role="menu"
                style={{ top: listMenuAt.y, left: listMenuAt.x }}
              >
                {ordered.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="menuitem"
                    className={tab.id === activeId ? 'active' : ''}
                    onClick={() => {
                      setListMenuAt(null);
                      onSelect(tab.id);
                    }}
                  >
                    {tab.live && <span className="live-dot" aria-label="running" />}
                    <span className="tab-list-item-title">{tab.title}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

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
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
            }}
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

      {contextMenu && (
        <>
          <div className="menu-backdrop" onClick={() => setContextMenu(null)} role="presentation" />
          <div
            className="menu tab-context-menu"
            role="menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setContextMenu(null);
                onCloseAll();
              }}
            >
              Close All
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={ordered.length <= 1}
              onClick={() => {
                setContextMenu(null);
                onCloseOthers(contextMenu.tabId);
              }}
            >
              Close all except this one
            </button>
          </div>
        </>
      )}
    </>
  );
}

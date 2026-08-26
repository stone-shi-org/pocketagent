import { describe, expect, it } from 'vitest';
import { fallbackAfterClose, tabIdFor, tabListReducer, type OpenTab } from './tab-list.js';

const tabA: OpenTab = { id: 't:a', route: { name: 'terminal', sessionId: 'a' } };
const tabB: OpenTab = { id: 't:b', route: { name: 'terminal', sessionId: 'b' } };
const tabC: OpenTab = { id: 'c:c', route: { name: 'chat', conversationId: 'c' } };

describe('tabIdFor', () => {
  it('namespaces terminal and chat ids so they can never collide', () => {
    expect(tabIdFor({ name: 'terminal', sessionId: 'x' })).toBe('t:x');
    expect(tabIdFor({ name: 'chat', conversationId: 'x' })).toBe('c:x');
  });
});

describe('tabListReducer: sync', () => {
  it('appends the routed tab when it is not already open', () => {
    const next = tabListReducer([tabA], { type: 'sync', route: tabB.route });
    expect(next).toEqual([tabA, tabB]);
  });

  it('returns the same array reference when the tab is already open', () => {
    const tabs = [tabA, tabB];
    const next = tabListReducer(tabs, { type: 'sync', route: tabA.route });
    expect(next).toBe(tabs);
  });

  it('ignores a non-tabbable route (compose/agents/list)', () => {
    const tabs = [tabA];
    expect(tabListReducer(tabs, { type: 'sync', route: { name: 'list' } })).toBe(tabs);
    expect(tabListReducer(tabs, { type: 'sync', route: { name: 'agents' } })).toBe(tabs);
    expect(tabListReducer(tabs, { type: 'sync', route: { name: 'compose' } })).toBe(tabs);
  });
});

describe('tabListReducer: openPreview', () => {
  it('appends a new tab marked preview when none is open yet', () => {
    const next = tabListReducer([], { type: 'openPreview', route: tabA.route });
    expect(next).toEqual([{ ...tabA, preview: true }]);
  });

  it('reuses the existing preview tab\'s own slot for a different chat', () => {
    const tabs: OpenTab[] = [tabB, { ...tabA, preview: true }];
    const next = tabListReducer(tabs, { type: 'openPreview', route: tabC.route });
    expect(next).toEqual([tabB, { ...tabC, preview: true }]);
  });

  it('is a no-op for a chat that is already open, preview or not', () => {
    const tabs: OpenTab[] = [tabA, { ...tabB, preview: true }];
    expect(tabListReducer(tabs, { type: 'openPreview', route: tabA.route })).toBe(tabs);
    expect(tabListReducer(tabs, { type: 'openPreview', route: tabB.route })).toBe(tabs);
  });

  it('appends rather than replacing when nothing is currently a preview tab', () => {
    const tabs: OpenTab[] = [tabA, tabB];
    expect(tabListReducer(tabs, { type: 'openPreview', route: tabC.route })).toEqual([
      tabA,
      tabB,
      { ...tabC, preview: true },
    ]);
  });
});

describe('tabListReducer: openPermanent', () => {
  it('appends a normal (non-preview) tab when the chat is not open yet', () => {
    expect(tabListReducer([], { type: 'openPermanent', route: tabA.route })).toEqual([tabA]);
  });

  it('keeps the preview tab open for good, in the same slot', () => {
    const tabs: OpenTab[] = [tabB, { ...tabA, preview: true }];
    expect(tabListReducer(tabs, { type: 'openPermanent', route: tabA.route })).toEqual([tabB, tabA]);
  });

  it('is a no-op for a tab that is already permanent', () => {
    const tabs: OpenTab[] = [tabA, tabB];
    expect(tabListReducer(tabs, { type: 'openPermanent', route: tabA.route })).toBe(tabs);
  });

  it('double-clicking a preview tab and then opening a new chat by single click does not evict the now-permanent tab', () => {
    // The scenario the whole feature is for: preview B, "keep" it with a
    // double click, then single-click a third chat — C should open as the
    // new preview without disturbing B, which is no longer a preview tab.
    let tabs: OpenTab[] = [tabA];
    tabs = tabListReducer(tabs, { type: 'openPreview', route: tabB.route });
    tabs = tabListReducer(tabs, { type: 'openPermanent', route: tabB.route });
    tabs = tabListReducer(tabs, { type: 'openPreview', route: tabC.route });
    expect(tabs).toEqual([tabA, tabB, { ...tabC, preview: true }]);
  });
});

describe('tabListReducer: close', () => {
  it('removes exactly the closed tab', () => {
    expect(tabListReducer([tabA, tabB, tabC], { type: 'close', id: tabB.id })).toEqual([tabA, tabC]);
  });

  it('is a no-op for an id that is not open', () => {
    const tabs = [tabA];
    expect(tabListReducer(tabs, { type: 'close', id: 'nope' })).toEqual(tabs);
  });

  it('threads two closes dispatched in the same tick to the same end state as two sequential closes', () => {
    // This is the shape a real double-click (or closing a fallback tab before
    // React has re-rendered) produces: two actions applied back to back to
    // whatever the list actually is, never a value cached from before either
    // ran. Closing every open tab must end at `[]`, not resurrect one.
    const afterFirst = tabListReducer([tabA, tabB], { type: 'close', id: tabA.id });
    const afterSecond = tabListReducer(afterFirst, { type: 'close', id: tabB.id });
    expect(afterSecond).toEqual([]);
  });
});

describe('fallbackAfterClose', () => {
  it('prefers the tab that slides into the closed one\'s slot', () => {
    expect(fallbackAfterClose([tabA, tabB, tabC], tabA.id)).toEqual(tabB);
  });

  it('falls back to the previous tab when the closed one was last', () => {
    expect(fallbackAfterClose([tabA, tabB, tabC], tabC.id)).toEqual(tabB);
  });

  it('returns null when closing the only open tab', () => {
    expect(fallbackAfterClose([tabA], tabA.id)).toBeNull();
  });

  it('returns null for an id that is not open', () => {
    expect(fallbackAfterClose([tabA, tabB], 'nope')).toBeNull();
  });

  it('matches closing every tab in sequence, including the one just fallen back to', () => {
    // The exact scenario that used to resurrect a ghost tab: close the active
    // tab, get told to fall back to its neighbor, then immediately close that
    // neighbor too (before anything about "what's active" has caught up).
    let tabs: OpenTab[] = [tabA, tabB];
    const firstFallback = fallbackAfterClose(tabs, tabA.id);
    tabs = tabListReducer(tabs, { type: 'close', id: tabA.id });
    expect(firstFallback).toEqual(tabB);

    const secondFallback = fallbackAfterClose(tabs, firstFallback!.id);
    tabs = tabListReducer(tabs, { type: 'close', id: firstFallback!.id });
    expect(secondFallback).toBeNull();
    expect(tabs).toEqual([]);
  });
});

describe('tabListReducer: reorder', () => {
  it('reorders to match the given id order', () => {
    expect(
      tabListReducer([tabA, tabB, tabC], { type: 'reorder', orderedIds: [tabC.id, tabA.id, tabB.id] }),
    ).toEqual([tabC, tabA, tabB]);
  });

  it('appends anything missing from the given order rather than dropping it', () => {
    expect(tabListReducer([tabA, tabB, tabC], { type: 'reorder', orderedIds: [tabB.id] })).toEqual([
      tabB,
      tabA,
      tabC,
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { fallbackAfterClose, tabIdFor, tabListReducer, type OpenTab } from './tab-list.js';

const tabA: OpenTab = { id: 't:a', route: { name: 'terminal', sessionId: 'a' } };
const tabB: OpenTab = { id: 't:b', route: { name: 'terminal', sessionId: 'b' } };
const tabC: OpenTab = { id: 'c:c', route: { name: 'chat', conversationId: 'c' } };
const tabP: OpenTab = { id: 'p:p1', route: { name: 'planner-chat', chatId: 'p1' } };
const tabS: OpenTab = { id: 's:settings', route: { name: 'settings' } };
const tabCron: OpenTab = { id: 's:settings', route: { name: 'cron' } };
const tabWebhooks: OpenTab = { id: 's:settings', route: { name: 'webhooks' } };
const tabWebhook: OpenTab = { id: 's:settings', route: { name: 'webhook', webhookId: 'w1' } };
const tabPlanner: OpenTab = { id: 's:settings', route: { name: 'planner' } };

describe('tabIdFor', () => {
  it('namespaces every tabbable route kind so they can never collide', () => {
    expect(tabIdFor({ name: 'terminal', sessionId: 'x' })).toBe('t:x');
    expect(tabIdFor({ name: 'chat', conversationId: 'x' })).toBe('c:x');
    expect(tabIdFor({ name: 'planner-chat', chatId: 'x' })).toBe('p:x');
  });

  it('maps every admin-page route to the same fixed sentinel id (PA-36 round 2)', () => {
    // The whole mechanism behind "Settings, Cron, Webhooks and Pocket Agents
    // all share one tab": dedup-by-id in `openPermanent`/`sync` does the
    // rest for free, exactly as it already did for Settings alone.
    expect(tabIdFor({ name: 'settings' })).toBe('s:settings');
    expect(tabIdFor({ name: 'cron' })).toBe('s:settings');
    expect(tabIdFor({ name: 'cron-job', jobId: 'j1' })).toBe('s:settings');
    expect(tabIdFor({ name: 'webhooks' })).toBe('s:settings');
    expect(tabIdFor({ name: 'webhook', webhookId: 'w1' })).toBe('s:settings');
    expect(tabIdFor({ name: 'planner' })).toBe('s:settings');
    expect(tabIdFor({ name: 'planner-agent', agentId: 'a1' })).toBe('s:settings');
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

  it('appends a Pocket Agent chat opened some other way (e.g. a webhook editor link)', () => {
    const next = tabListReducer([tabA], { type: 'sync', route: tabP.route });
    expect(next).toEqual([tabA, tabP]);
  });

  it('appends the singleton settings tab, and syncing it again is a no-op', () => {
    const withSettings = tabListReducer([tabA], { type: 'sync', route: tabS.route });
    expect(withSettings).toEqual([tabA, tabS]);
    expect(tabListReducer(withSettings, { type: 'sync', route: tabS.route })).toBe(withSettings);
  });

  it('navigating from one admin page to another updates the one shared tab in place, rather than opening a second one (PA-36 round 2)', () => {
    // The exact scenario the reporter asked for: Settings, Cron, Webhooks
    // and Pocket Agents share one tab, and switching between them has to
    // change what that tab shows — `sync` finding the id already open must
    // not, unlike every other tab kind, treat that as a no-op.
    let tabs: OpenTab[] = [tabA];
    tabs = tabListReducer(tabs, { type: 'sync', route: tabS.route });
    expect(tabs).toEqual([tabA, tabS]);

    tabs = tabListReducer(tabs, { type: 'sync', route: tabCron.route });
    expect(tabs).toEqual([tabA, tabCron]);
    expect(tabs.filter((t) => t.id === 's:settings')).toHaveLength(1);

    tabs = tabListReducer(tabs, { type: 'sync', route: tabWebhook.route });
    expect(tabs).toEqual([tabA, tabWebhook]);

    tabs = tabListReducer(tabs, { type: 'sync', route: tabPlanner.route });
    expect(tabs).toEqual([tabA, tabPlanner]);
  });

  it('re-syncing the exact same route object for the shared admin tab is still a true no-op', () => {
    // Selecting an already-active tab from the tab bar re-dispatches `sync`
    // with that tab's own stored route (same object, not a fresh one built
    // from a navigation) — this must not spuriously "update" anything, which
    // is what keeps `DesktopShell`'s reconcile effect from firing on every
    // render once the tab settles.
    const tabs: OpenTab[] = [tabA, tabWebhooks];
    expect(tabListReducer(tabs, { type: 'sync', route: tabWebhooks.route })).toBe(tabs);
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

  it('opens a Pocket Agent chat as a normal permanent tab', () => {
    expect(tabListReducer([tabA], { type: 'openPermanent', route: tabP.route })).toEqual([tabA, tabP]);
  });

  it('never opens a second settings tab, no matter how many times it is requested (PA-36)', () => {
    let tabs: OpenTab[] = [tabA];
    tabs = tabListReducer(tabs, { type: 'openPermanent', route: tabS.route });
    tabs = tabListReducer(tabs, { type: 'openPermanent', route: tabS.route });
    tabs = tabListReducer(tabs, { type: 'openPermanent', route: tabS.route });
    expect(tabs).toEqual([tabA, tabS]);
  });

  it('requesting a different admin page while the shared tab is already open under a different sub-route is a no-op here too — sync (not openPermanent) is what updates it', () => {
    // `openPermanent`'s own "already open and not preview: nothing to do"
    // rule is unchanged by PA-36 round 2 — `DesktopShell`'s menu actions
    // still resolve correctly because the `route` prop change that follows
    // is picked up by the very next `sync`, not because this action itself
    // switched the content. See the `sync` tests above for that half.
    const tabs: OpenTab[] = [tabA, tabCron];
    expect(tabListReducer(tabs, { type: 'openPermanent', route: tabS.route })).toBe(tabs);
  });
});

describe('tabListReducer: replace', () => {
  it('promotes a preview tab in place to a permanent tab under a new session (PA-46)', () => {
    const previewTabA: OpenTab = { ...tabA, preview: true };
    const tabs: OpenTab[] = [tabB, previewTabA, tabC];
    const newSessionTab: OpenTab = { id: 't:new1', route: { name: 'terminal', sessionId: 'new1' } };

    const next = tabListReducer(tabs, { type: 'replace', id: tabA.id, route: newSessionTab.route });
    expect(next).toEqual([tabB, newSessionTab, tabC]);
    expect(next[1]?.preview).toBeUndefined();
  });

  it('replaces a permanent tab in place when superseded (e.g. reattaching/resuming)', () => {
    const tabs: OpenTab[] = [tabA, tabB, tabC];
    const newSessionTab: OpenTab = { id: 't:new1', route: { name: 'terminal', sessionId: 'new1' } };

    const next = tabListReducer(tabs, { type: 'replace', id: tabB.id, route: newSessionTab.route });
    expect(next).toEqual([tabA, newSessionTab, tabC]);
  });

  it('appends as a permanent tab if the replaced tab id is not currently open', () => {
    const tabs: OpenTab[] = [tabA, tabB];
    const newSessionTab: OpenTab = { id: 't:new1', route: { name: 'terminal', sessionId: 'new1' } };

    const next = tabListReducer(tabs, { type: 'replace', id: 't:nonexistent', route: newSessionTab.route });
    expect(next).toEqual([tabA, tabB, newSessionTab]);
  });

  it('does not duplicate if the new route is already open when replacing a missing tab', () => {
    const tabs: OpenTab[] = [tabA, tabB];
    const next = tabListReducer(tabs, { type: 'replace', id: 't:nonexistent', route: tabB.route });
    expect(next).toBe(tabs);
  });
});

describe('tabListReducer: close', () => {
  it('removes exactly the closed tab', () => {
    expect(tabListReducer([tabA, tabB, tabC], { type: 'close', id: tabB.id })).toEqual([tabA, tabC]);
  });

  it('closes a Pocket Agent chat tab, e.g. once its `PlannerChatPage` discovers the chat is gone', () => {
    expect(tabListReducer([tabA, tabP], { type: 'close', id: tabP.id })).toEqual([tabA]);
  });

  it('closes the settings tab, freeing the singleton slot for a later re-open', () => {
    expect(tabListReducer([tabA, tabS], { type: 'close', id: tabS.id })).toEqual([tabA]);
  });

  it('closing the shared admin tab closes whichever of the seven sub-pages it currently shows (PA-36 round 2)', () => {
    expect(tabListReducer([tabA, tabWebhooks], { type: 'close', id: tabWebhooks.id })).toEqual([tabA]);
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

  it('reorders a mix of every tabbable route kind, including planner-chat and settings', () => {
    expect(
      tabListReducer([tabA, tabP, tabS], { type: 'reorder', orderedIds: [tabS.id, tabP.id, tabA.id] }),
    ).toEqual([tabS, tabP, tabA]);
  });

  it('appends anything missing from the given order rather than dropping it', () => {
    expect(tabListReducer([tabA, tabB, tabC], { type: 'reorder', orderedIds: [tabB.id] })).toEqual([
      tabB,
      tabA,
      tabC,
    ]);
  });
});

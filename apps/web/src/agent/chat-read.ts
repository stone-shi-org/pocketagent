import { useEffect, useState } from 'react';
import type { ChatReadKind } from '@pocketagent/protocol';
import { useHostApi } from '../hosts/HostContext.js';

/**
 * PA-165: tell the server a chat is on screen, which clears its unread dot on
 * every device.
 *
 * "On screen" is the page's own `active` (the desktop keeps every tab
 * mounted, and only one is visible) AND the document being visible — a tab
 * left open behind another window has not been read. It fires on becoming
 * visible and again each time `turnSignal` changes while visible, which a
 * page bumps on `turn_complete`: watching a turn finish is reading it.
 *
 * Failures are ignored. The worst case is a dot that stays green until the
 * next mark, and a chat that vanished mid-view (404) has no dot to clear.
 */
export function useMarkChatRead(
  kind: ChatReadKind,
  id: string | null,
  { active, turnSignal }: { active: boolean; turnSignal: number },
): void {
  const api = useHostApi();
  const documentVisible = useDocumentVisible();
  const onScreen = active && documentVisible && id !== null;
  useEffect(() => {
    if (!onScreen || id === null) return;
    api.markChatRead(kind, id).catch(() => {
      // See the doc comment: nothing to do.
    });
  }, [api, kind, id, onScreen, turnSignal]);
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
  );
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onChange = (): void => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

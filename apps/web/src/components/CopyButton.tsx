import { useEffect, useRef, useState } from 'react';
import { copyText } from '../agent/clipboard.js';
import { Icon } from './Icon.js';

type State = 'idle' | 'copied' | 'failed';

/**
 * Copy the source text of a message.
 *
 * Copies what the agent actually wrote, not what is on screen: the rendered
 * markdown would paste as prose with the fences and list markers stripped, and
 * a code block you cannot paste back into an editor is not much use.
 */
export function CopyButton({
  text,
  label = 'Copy',
}: {
  text: string;
  label?: string;
}): JSX.Element {
  const [state, setState] = useState<State>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onClick = async (): Promise<void> => {
    const ok = await copyText(text);
    setState(ok ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), ok ? 1400 : 2600);
  };

  return (
    <button
      type="button"
      className={`copy-btn ${state}`}
      onClick={() => void onClick()}
      aria-label={label}
      title={state === 'failed' ? 'Could not copy — select the text instead' : label}
    >
      <Icon name={state === 'copied' ? 'check' : 'copy'} size={15} />
      {/* Icon only, except when it did not work: a red icon on its own is
          ambiguous, and a copy that silently fails is worse than a wordy one.
          The accessible name lives on `aria-label` either way. */}
      {state === 'failed' && <span className="copy-label">Couldn&rsquo;t copy</span>}
    </button>
  );
}

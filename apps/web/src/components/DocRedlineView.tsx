import type { DocRedlineBlock } from '@pocketagent/protocol';

export function DocRedlineView({
  blocks,
  className = '',
}: {
  blocks: readonly DocRedlineBlock[];
  className?: string;
}): JSX.Element {
  return (
    <div className={`doc-redline-view${className ? ` ${className}` : ''}`} data-testid="doc-redline-view">
      {blocks.map((block, bIdx) => (
        <div key={bIdx} className="doc-redline-block">
          {block.location && <span className="doc-redline-location">[{block.location}]</span>}
          <span className="doc-redline-segments">
            {block.segments.map((seg, sIdx) => {
              const title = [seg.author, seg.date].filter(Boolean).join(' · ') || undefined;
              if (seg.type === 'del') {
                return (
                  <del key={sIdx} className="doc-redline-del" title={title}>
                    {seg.text}
                  </del>
                );
              }
              if (seg.type === 'ins') {
                return (
                  <ins key={sIdx} className="doc-redline-ins" title={title}>
                    {seg.text}
                  </ins>
                );
              }
              if (seg.type === 'comment') {
                return (
                  <span key={sIdx} className="doc-redline-comment" title={title}>
                    [Comment{seg.author ? ` (${seg.author})` : ''}: {seg.text}]
                  </span>
                );
              }
              return (
                <span key={sIdx} className="doc-redline-equal">
                  {seg.text}
                </span>
              );
            })}
          </span>
        </div>
      ))}
    </div>
  );
}

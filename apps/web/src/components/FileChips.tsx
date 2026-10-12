import { createContext, useContext } from 'react';
import type { PromptFileChip } from '../agent/transcript.js';
import { formatFileSize, type PendingFile } from '../agent/file-attachment.js';
import { CopyButton } from './CopyButton.js';
import { Icon } from './Icon.js';

/**
 * PA-136: turns a landed file's path into a link, or `null` for "no link".
 * Provided by the page, because only the page knows what can serve the file:
 * a Pocket Agent's uploads sit in its `artifacts/` and have a download route,
 * a coding agent's sit in the user's own repository and have none (the chip
 * offers to copy the path instead). A context, so the transcript's three
 * layers of components need not each thread a prop they never read.
 */
export const AttachmentHrefContext = createContext<((path: string) => string | null) | null>(null);

/** The files a sent user turn attached, under its header. */
export function SentFileChips({ files }: { files: readonly PromptFileChip[] }): JSX.Element {
  const hrefFor = useContext(AttachmentHrefContext);
  return (
    <div className="file-chip-row" aria-label="Attached files">
      {files.map((file) => {
        const href = hrefFor?.(file.path) ?? null;
        const size = file.size !== undefined ? formatFileSize(file.size) : null;
        // PA-137: whether the agent could read a document's text, so a reply
        // that ignores a scan is explained by the chip rather than a mystery.
        const read =
          file.extractError !== undefined
            ? 'text not readable'
            : file.extractedChars !== undefined
              ? `text read${file.truncated ? ' (partly)' : ''}`
              : null;
        const detail = [size, read].filter(Boolean).join(' · ') || null;
        const title = file.extractError ? `${file.path}\n${file.extractError}` : file.path;
        const body = (
          <>
            <Icon name="file" size={15} />
            <span className="file-chip-name">{file.name}</span>
            {detail && <span className="file-chip-detail">{detail}</span>}
          </>
        );
        return (
          <span key={file.path} className="file-chip" title={title}>
            {href ? (
              <a className="file-chip-link" href={href} target="_blank" rel="noreferrer" download={file.name}>
                {body}
              </a>
            ) : (
              <span className="file-chip-link">{body}</span>
            )}
            {!href && <CopyButton text={file.path} label="Copy path" />}
          </span>
        );
      })}
    </div>
  );
}

/** The files waiting in the composer, with their upload state. */
export function PendingFileChips({
  files,
  onRemove,
}: {
  files: readonly PendingFile[];
  onRemove: (localId: string) => void;
}): JSX.Element {
  return (
    <div className="file-chip-row pending" aria-label="Files to send">
      {files.map((file) => (
        <span
          key={file.localId}
          className={`file-chip ${file.state}`}
          title={file.error ?? `${file.name} — ${formatFileSize(file.size)}`}
        >
          <span className="file-chip-link">
            <Icon name="file" size={15} />
            <span className="file-chip-name">{file.name}</span>
            <span className="file-chip-detail">
              {file.state === 'uploading' ? 'Uploading…' : file.state === 'error' ? 'Failed' : formatFileSize(file.size)}
            </span>
          </span>
          <button
            type="button"
            className="file-chip-remove"
            onClick={() => onRemove(file.localId)}
            aria-label={`Remove ${file.name}`}
          >
            <Icon name="close" size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

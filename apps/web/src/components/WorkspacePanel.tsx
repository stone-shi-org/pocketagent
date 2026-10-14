import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import type {
  DocFileEntry,
  DocFileExtractStatus,
  DocFilePreviewResponse,
  DocWorkspace,
  DocWorkspaceExtractionProgress,
} from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { useHostApi } from '../hosts/HostContext.js';
import { renderMarkdown } from '../agent/markdown.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { Icon } from './Icon.js';

interface Props {
  workspace: DocWorkspace;
  entries: DocFileEntry[];
  progress: DocWorkspaceExtractionProgress;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onClose: () => void;
  onUseInChat: (relPath: string) => void;
  onWorkspaceUpdated?: (workspace: DocWorkspace) => void;
}

interface TreeNode {
  entry: DocFileEntry;
  children: TreeNode[];
}

function buildTree(entries: readonly DocFileEntry[]): TreeNode[] {
  const byPath = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  const sorted = [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  for (const entry of sorted) {
    byPath.set(entry.path, { entry, children: [] });
  }

  for (const entry of sorted) {
    const node = byPath.get(entry.path)!;
    const slash = entry.path.lastIndexOf('/');
    if (slash > 0) {
      const parentPath = entry.path.slice(0, slash);
      const parentNode = byPath.get(parentPath);
      if (parentNode && parentNode.entry.isDir) {
        parentNode.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }

  const sortChildren = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => {
      if (a.entry.isDir !== b.entry.isDir) return a.entry.isDir ? -1 : 1;
      return a.entry.name.localeCompare(b.entry.name);
    });
    for (const n of nodes) {
      if (n.children.length > 0) sortChildren(n.children);
    }
  };
  sortChildren(roots);
  return roots;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sanitizeDocxHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
    FORBID_ATTR: ['style', 'onerror', 'onload'],
  });
}

function statusBadgeLabel(status: DocFileExtractStatus): string | null {
  switch (status) {
    case 'extracted':
      return 'extracted';
    case 'extracting':
      return 'extracting…';
    case 'failed':
      return 'failed';
    case 'scanned':
      return 'scanned';
    case 'changed':
      return 'changed';
    default:
      return null;
  }
}

export function WorkspacePanel({
  workspace,
  entries,
  progress,
  loading,
  error,
  onRefresh,
  onClose,
  onUseInChat,
  onWorkspaceUpdated,
}: Props): JSX.Element {
  const api = useHostApi();
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set());
  const [selectedDir, setSelectedDir] = useState<string>('');
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [mkdirValue, setMkdirValue] = useState('');
  const [renamingEntry, setRenamingEntry] = useState<DocFileEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deletingEntry, setDeletingEntry] = useState<DocFileEntry | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [uploadingCount, setUploadingCount] = useState(0);

  // Preview state
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<DocFilePreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [activeSheetIdx, setActiveSheetIdx] = useState(0);
  const [showDerivedText, setShowDerivedText] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const tree = useMemo(() => buildTree(entries), [entries]);
  const hasBrief = useMemo(
    () => entries.some((e) => !e.isDir && e.path === 'WORKSPACE.md'),
    [entries],
  );

  // Set webkitdirectory attribute imperatively so TypeScript JSX types stay clean.
  useEffect(() => {
    const el = folderInputRef.current;
    if (el) {
      el.setAttribute('webkitdirectory', '');
      el.setAttribute('directory', '');
    }
  }, []);

  const toggleDir = (relPath: string): void => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
  };

  const openPreview = useCallback(
    async (relPath: string) => {
      setPreviewPath(relPath);
      setPreviewLoading(true);
      setPreviewError(null);
      setActiveSheetIdx(0);
      setShowDerivedText(false);
      try {
        const res = await api.previewDocWorkspaceFile(workspace.id, relPath);
        setPreviewData(res);
      } catch (err) {
        setPreviewData(null);
        setPreviewError(err instanceof ApiError ? err.message : String(err));
      } finally {
        setPreviewLoading(false);
      }
    },
    [api, workspace.id],
  );

  const handleUploadFiles = async (files: File[], baseDir: string): Promise<void> => {
    if (files.length === 0) return;
    setActionError(null);
    setUploadingCount((c) => c + files.length);
    try {
      for (const file of files) {
        const webkitRel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
        const relSubPath = webkitRel && webkitRel.length > 0 ? webkitRel : file.name;
        const targetDir = baseDir ? baseDir.replace(/\/+$/, '') : '';
        const relDir = relSubPath.includes('/')
          ? [targetDir, relSubPath.slice(0, relSubPath.lastIndexOf('/'))].filter(Boolean).join('/')
          : targetDir;
        const fileName = relSubPath.includes('/')
          ? relSubPath.slice(relSubPath.lastIndexOf('/') + 1)
          : relSubPath;
        await api.uploadDocWorkspaceFile(workspace.id, file, {
          dir: relDir || undefined,
          name: fileName || file.name,
        });
      }
      onRefresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Upload failed.');
    } finally {
      setUploadingCount((c) => Math.max(0, c - files.length));
    }
  };

  const handleMkdir = async (): Promise<void> => {
    const trimmed = mkdirValue.trim().replace(/^\/+|\/+$/g, '');
    if (!trimmed) return;
    const fullRel = selectedDir ? `${selectedDir}/${trimmed}` : trimmed;
    setBusyAction(true);
    setActionError(null);
    try {
      await api.mkdirDocWorkspaceFile(workspace.id, { path: fullRel });
      setMkdirOpen(false);
      setMkdirValue('');
      onRefresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not create folder.');
    } finally {
      setBusyAction(false);
    }
  };

  const handleRename = async (): Promise<void> => {
    if (!renamingEntry) return;
    const trimmed = renameValue.trim().replace(/^\/+|\/+$/g, '');
    if (!trimmed || trimmed === renamingEntry.path) {
      setRenamingEntry(null);
      return;
    }
    setBusyAction(true);
    setActionError(null);
    try {
      await api.renameDocWorkspaceFile(workspace.id, {
        fromPath: renamingEntry.path,
        toPath: trimmed,
      });
      if (previewPath === renamingEntry.path) {
        setPreviewPath(trimmed);
      }
      setRenamingEntry(null);
      onRefresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not rename or move.');
    } finally {
      setBusyAction(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!deletingEntry) return;
    setBusyAction(true);
    setActionError(null);
    try {
      await api.deleteDocWorkspaceFile(workspace.id, deletingEntry.path);
      if (previewPath === deletingEntry.path) {
        setPreviewPath(null);
        setPreviewData(null);
      }
      setDeletingEntry(null);
      onRefresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not delete.');
    } finally {
      setBusyAction(false);
    }
  };

  const handleCreateBrief = async (): Promise<void> => {
    setBusyAction(true);
    setActionError(null);
    try {
      await api.createDocWorkspaceBrief(workspace.id);
      onRefresh();
      await openPreview('WORKSPACE.md');
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not create WORKSPACE.md.');
    } finally {
      setBusyAction(false);
    }
  };

  const handleToggleAutoApprove = async (): Promise<void> => {
    try {
      const updated = await api.updateDocWorkspace(workspace.id, {
        autoApproveEdits: !workspace.autoApproveEdits,
      });
      onWorkspaceUpdated?.(updated);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not update workspace setting.');
    }
  };

  const downloadFile = (relPath: string, fileName: string): void => {
    const url = api.docWorkspaceFileDownloadUrl(workspace.id, relPath, false);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const downloadZip = (subPath?: string): void => {
    const url = api.docWorkspaceZipUrl(workspace.id, subPath);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${workspace.name}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const renderNode = (node: TreeNode, depth: number): JSX.Element => {
    const { entry } = node;
    const isDir = entry.isDir;
    const isCollapsed = collapsedDirs.has(entry.path);
    const isRenaming = renamingEntry?.path === entry.path;
    const badge = !isDir ? statusBadgeLabel(entry.extractStatus) : null;
    const isSelectedTarget = isDir && selectedDir === entry.path;

    return (
      <li key={entry.path} className="doc-workspace-tree-node">
        <div
          className={`planner-artifact-item doc-workspace-item${
            previewPath === entry.path ? ' active' : ''
          }${isSelectedTarget ? ' target-dir' : ''}`}
          style={{ paddingLeft: `${12 + depth * 14}px` }}
        >
          {isRenaming ? (
            <form
              className="doc-workspace-rename-form"
              onSubmit={(e) => {
                e.preventDefault();
                void handleRename();
              }}
            >
              <input
                type="text"
                className="project-rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                autoFocus
                aria-label="New relative path"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setRenamingEntry(null);
                }}
              />
              <button type="submit" className="planner-artifact-btn" disabled={busyAction} title="Save">
                <Icon name="check" size={13} />
              </button>
              <button
                type="button"
                className="planner-artifact-btn"
                onClick={() => setRenamingEntry(null)}
                title="Cancel"
              >
                <Icon name="close" size={13} />
              </button>
            </form>
          ) : (
            <>
              <button
                type="button"
                className="planner-artifact-main"
                onClick={() => {
                  if (isDir) {
                    toggleDir(entry.path);
                    setSelectedDir((prev) => (prev === entry.path ? '' : entry.path));
                  } else {
                    void openPreview(entry.path);
                  }
                }}
                title={entry.extractError ? `${entry.path} — ${entry.extractError}` : entry.path}
              >
                <span className="planner-artifact-icon">
                  {isDir ? (
                    <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={13} />
                  ) : (
                    <Icon name="file" size={14} />
                  )}
                </span>
                <span className="planner-artifact-info">
                  <span className="planner-artifact-name">
                    {entry.name}
                    {badge && (
                      <span
                        className={`doc-status-badge status-${entry.extractStatus}`}
                        title={entry.extractError ?? `Status: ${entry.extractStatus}`}
                      >
                        {badge}
                      </span>
                    )}
                  </span>
                  {!isDir && (
                    <span className="planner-artifact-meta">{formatFileSize(entry.size)}</span>
                  )}
                </span>
              </button>
              <div className="planner-artifact-item-actions">
                {!isDir && (
                  <button
                    type="button"
                    className="planner-artifact-btn"
                    onClick={() => onUseInChat(entry.path)}
                    aria-label={`Use ${entry.path} in chat`}
                    title={`Mention @${entry.path} in chat`}
                  >
                    <span className="doc-at-glyph">@</span>
                  </button>
                )}
                <button
                  type="button"
                  className="planner-artifact-btn"
                  onClick={() => {
                    setRenamingEntry(entry);
                    setRenameValue(entry.path);
                  }}
                  aria-label={`Rename or move ${entry.path}`}
                  title="Rename / move"
                >
                  <Icon name="edit" size={13} />
                </button>
                {isDir ? (
                  <button
                    type="button"
                    className="planner-artifact-btn"
                    onClick={() => downloadZip(entry.path)}
                    aria-label={`Download ${entry.path} as zip`}
                    title="Download folder as .zip"
                  >
                    <Icon name="download" size={13} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="planner-artifact-btn"
                    onClick={() => downloadFile(entry.path, entry.name)}
                    aria-label={`Download ${entry.path}`}
                    title="Download file"
                  >
                    <Icon name="download" size={13} />
                  </button>
                )}
                <button
                  type="button"
                  className="planner-artifact-btn danger"
                  onClick={() => setDeletingEntry(entry)}
                  aria-label={`Delete ${entry.path}`}
                  title="Delete"
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            </>
          )}
        </div>
        {isDir && !isCollapsed && node.children.length > 0 && (
          <ul className="doc-workspace-Subtree">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <>
      <div
        className="planner-artifacts-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="planner-artifacts-panel doc-workspace-panel" aria-label="Document workspace side panel">
        <div className="planner-artifacts-header">
          <div className="planner-artifacts-title">
            <Icon name="folder" size={15} />
            <span title={workspace.path}>{workspace.name}</span>
            <span className="planner-artifacts-badge">
              {entries.filter((e) => !e.isDir).length}
            </span>
          </div>
          <div className="planner-artifacts-actions">
            <button
              type="button"
              className="planner-artifact-btn"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Upload files to workspace"
              title={selectedDir ? `Upload files to ${selectedDir}/` : 'Upload files to workspace'}
            >
              <Icon name="upload" size={14} />
            </button>
            <button
              type="button"
              className="planner-artifact-btn"
              onClick={() => folderInputRef.current?.click()}
              aria-label="Upload folder to workspace"
              title="Upload folder"
            >
              <Icon name="folder" size={14} />
            </button>
            <button
              type="button"
              className="planner-artifact-btn"
              onClick={() => {
                setMkdirOpen((v) => !v);
                setMkdirValue('');
              }}
              aria-label="New folder"
              title="New folder"
            >
              <Icon name="plus" size={14} />
            </button>
            <button
              type="button"
              className="planner-artifact-btn"
              onClick={() => downloadZip()}
              aria-label="Download workspace as zip"
              title="Download workspace as .zip"
            >
              <Icon name="download" size={14} />
            </button>
            <button
              type="button"
              className="planner-artifact-btn"
              onClick={onRefresh}
              disabled={loading}
              aria-label="Refresh workspace files"
              title="Refresh workspace files"
            >
              <Icon name="rotate" size={14} />
            </button>
            <button
              type="button"
              className="planner-artifact-btn"
              onClick={onClose}
              aria-label="Close workspace panel"
              title="Close panel"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const list = e.target.files ? Array.from(e.target.files) : [];
            e.target.value = '';
            void handleUploadFiles(list, selectedDir);
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const list = e.target.files ? Array.from(e.target.files) : [];
            e.target.value = '';
            void handleUploadFiles(list, selectedDir);
          }}
        />

        <div className="doc-workspace-subbar">
          <span className="doc-workspace-path" title={workspace.path}>
            {workspace.path}
          </span>
          <div className="doc-workspace-subbar-actions">
            {!hasBrief && (
              <button
                type="button"
                className="planner-btn small"
                onClick={() => void handleCreateBrief()}
                disabled={busyAction}
                title="Create a WORKSPACE.md brief loaded into the agent system prompt"
              >
                Create brief
              </button>
            )}
            <button
              type="button"
              className={`planner-btn small${workspace.autoApproveEdits ? ' active' : ''}`}
              onClick={() => void handleToggleAutoApprove()}
              title="When on, agent file edits inside this workspace run without asking each time"
            >
              {workspace.autoApproveEdits ? 'Auto-approve edits: ON' : 'Auto-approve edits: OFF'}
            </button>
          </div>
        </div>

        {(progress.extracting > 0 || uploadingCount > 0) && (
          <div className="doc-workspace-progress" role="status" aria-live="polite">
            {uploadingCount > 0 ? (
              <span>Uploading {uploadingCount} file{uploadingCount === 1 ? '' : 's'}…</span>
            ) : (
              <span>
                Extracting documents ({progress.completed}/{progress.total})…
              </span>
            )}
          </div>
        )}

        {mkdirOpen && (
          <form
            className="doc-workspace-mkdir-bar"
            onSubmit={(e) => {
              e.preventDefault();
              void handleMkdir();
            }}
          >
            <input
              type="text"
              className="project-rename-input"
              placeholder={selectedDir ? `New folder in ${selectedDir}/…` : 'New folder name…'}
              value={mkdirValue}
              onChange={(e) => setMkdirValue(e.target.value)}
              autoFocus
            />
            <button type="submit" className="planner-btn small" disabled={busyAction || !mkdirValue.trim()}>
              Create
            </button>
            <button type="button" className="planner-btn small" onClick={() => setMkdirOpen(false)}>
              Cancel
            </button>
          </form>
        )}

        {(error || actionError) && (
          <div className="planner-artifacts-error" role="alert">
            {actionError ?? error}
          </div>
        )}

        {previewPath ? (
          <div className="doc-workspace-preview">
            <div className="doc-workspace-preview-header">
              <button
                type="button"
                className="planner-btn small"
                onClick={() => {
                  setPreviewPath(null);
                  setPreviewData(null);
                  setPreviewError(null);
                }}
              >
                <Icon name="chevron-left" size={13} />
                <span>Files</span>
              </button>
              <span className="doc-workspace-preview-title" title={previewPath}>
                {previewPath}
              </span>
              <div className="doc-workspace-preview-actions">
                {previewData?.text &&
                  (previewData.previewKind === 'docx_html' ||
                    previewData.previewKind === 'xlsx_grid' ||
                    previewData.previewKind === 'markdown') && (
                    <button
                      type="button"
                      className="planner-btn small"
                      onClick={() => setShowDerivedText((v) => !v)}
                    >
                      {showDerivedText ? 'Rendered' : 'Text'}
                    </button>
                  )}
                <button
                  type="button"
                  className="planner-btn small"
                  onClick={() => onUseInChat(previewPath)}
                  title={`Mention @${previewPath} in chat`}
                >
                  Use in chat
                </button>
                <button
                  type="button"
                  className="planner-btn small"
                  onClick={() => downloadFile(previewPath, previewPath.split('/').pop() ?? previewPath)}
                  title="Download file"
                >
                  <Icon name="download" size={13} />
                </button>
              </div>
            </div>

            <div className="doc-workspace-preview-body">
              {previewLoading ? (
                <div className="planner-artifacts-loading">Loading preview…</div>
              ) : previewError ? (
                <div className="planner-artifacts-error">{previewError}</div>
              ) : !previewData ? null : showDerivedText && previewData.text ? (
                <pre className="doc-workspace-preview-text">{previewData.text}</pre>
              ) : previewData.previewKind === 'pdf' ? (
                <iframe
                  className="doc-workspace-pdf-frame"
                  src={api.docWorkspaceFileDownloadUrl(workspace.id, previewData.path, true)}
                  title={`Preview ${previewData.path}`}
                />
              ) : previewData.previewKind === 'docx_html' ? (
                <div
                  className="doc-workspace-docx-html markdown-body"
                  dangerouslySetInnerHTML={{
                    __html: sanitizeDocxHtml(previewData.html ?? ''),
                  }}
                />
              ) : previewData.previewKind === 'xlsx_grid' ? (
                <div className="doc-workspace-xlsx">
                  {previewData.sheets && previewData.sheets.length > 0 ? (
                    <>
                      <div className="doc-workspace-sheet-tabs" role="tablist">
                        {previewData.sheets.map((sheet, idx) => (
                          <button
                            key={sheet.name}
                            type="button"
                            role="tab"
                            aria-selected={idx === activeSheetIdx}
                            className={`planner-btn small${idx === activeSheetIdx ? ' active' : ''}`}
                            onClick={() => setActiveSheetIdx(idx)}
                          >
                            {sheet.name} ({sheet.totalRows})
                          </button>
                        ))}
                      </div>
                      {(() => {
                        const sheet = previewData.sheets[activeSheetIdx] ?? previewData.sheets[0];
                        if (!sheet) return null;
                        return (
                          <div className="doc-workspace-sheet-table-wrap">
                            <table className="doc-workspace-sheet-table">
                              <tbody>
                                {sheet.rows.map((row, rIdx) => (
                                  <tr key={rIdx}>
                                    <td className="row-num">{rIdx + 1}</td>
                                    {row.map((cell, cIdx) => (
                                      <td key={cIdx}>{cell}</td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        );
                      })()}
                    </>
                  ) : (
                    <pre className="doc-workspace-preview-text">{previewData.text ?? 'Empty workbook'}</pre>
                  )}
                </div>
              ) : previewData.previewKind === 'markdown' ? (
                <div
                  className="doc-workspace-markdown markdown-body"
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(previewData.text ?? ''),
                  }}
                />
              ) : previewData.previewKind === 'text' ? (
                <pre className="doc-workspace-preview-text">
                  {previewData.text ?? ''}
                </pre>
              ) : (
                <div className="planner-artifacts-empty">
                  <p className="planner-artifacts-empty-title">Binary file</p>
                  <p className="planner-artifacts-empty-desc">
                    {formatFileSize(previewData.size)} — download to view.
                  </p>
                </div>
              )}
            </div>
          </div>
        ) : loading && entries.length === 0 ? (
          <div className="planner-artifacts-loading">Loading workspace files…</div>
        ) : entries.length === 0 ? (
          <div
            className="planner-artifacts-empty"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }}
            onDrop={(e) => {
              e.preventDefault();
              const files = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
              void handleUploadFiles(files, selectedDir);
            }}
          >
            <Icon name="folder" size={32} />
            <p className="planner-artifacts-empty-title">Workspace folder is empty</p>
            <p className="planner-artifacts-empty-desc">
              Upload PDFs, Word docs, spreadsheets, presentations, or text files, or create a{' '}
              <code>WORKSPACE.md</code> brief.
            </p>
          </div>
        ) : (
          <ul
            className="planner-artifacts-list doc-workspace-tree"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }}
            onDrop={(e) => {
              e.preventDefault();
              const files = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
              void handleUploadFiles(files, selectedDir);
            }}
          >
            {tree.map((node) => renderNode(node, 0))}
          </ul>
        )}

        {deletingEntry && (
          <ConfirmDialog
            title={`Delete ${deletingEntry.isDir ? 'folder' : 'file'}?`}
            body={`Are you sure you want to delete "${deletingEntry.path}" from the workspace folder on disk? This cannot be undone.`}
            confirmLabel={busyAction ? 'Deleting…' : 'Delete'}
            danger={true}
            busy={busyAction}
            onConfirm={() => void handleDelete()}
            onCancel={() => setDeletingEntry(null)}
          />
        )}
      </aside>
    </>
  );
}

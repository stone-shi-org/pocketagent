import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import type {
  DocFileEntry,
  DocFileExtractStatus,
  DocFilePreviewResponse,
  DocFileVersion,
  DocSearchResultHit,
  DocTrashEntry,
  DocVersionCompareResponse,
  DocWorkspace,
  DocWorkspaceExtractionProgress,
  DocWorkspaceIndexMode,
  DocWorkspaceIndexStatus,
  DocWorkspaceSearchResponse,
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

function formatTimestamp(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(ms);
  }
}

function formatActorLabel(actor: string): string {
  if (actor === 'user') return 'User';
  if (actor === 'external') return 'External';
  if (actor.startsWith('agent:')) {
    const chatId = actor.slice('agent:'.length);
    return chatId ? `Agent (${chatId.slice(0, 8)})` : 'Agent';
  }
  return actor;
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

export function parsePdfPageFromLocation(location: string | null): number | null {
  if (!location) return null;
  const match = /^p\.(\d+)\b/i.exec(location.trim());
  if (!match) return null;
  const page = Number.parseInt(match[1]!, 10);
  return Number.isFinite(page) && page >= 1 ? page : null;
}

export function parseSheetNameFromLocation(location: string | null): string | null {
  if (!location) return null;
  const bang = location.indexOf('!');
  if (bang > 0) return location.slice(0, bang).trim();
  return null;
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
  const [previewLocation, setPreviewLocation] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<DocFilePreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [activeSheetIdx, setActiveSheetIdx] = useState(0);
  const [showDerivedText, setShowDerivedText] = useState(false);
  const previewHtmlRef = useRef<HTMLDivElement>(null);

  // Search & index state (PA-144)
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResponse, setSearchResponse] = useState<DocWorkspaceSearchResponse | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [pendingEmbeddingsDisclosure, setPendingEmbeddingsDisclosure] = useState(false);
  const [indexStatusOverride, setIndexStatusOverride] = useState<DocWorkspaceIndexStatus | null>(null);

  // History state (PA-143)
  const [historyPath, setHistoryPath] = useState<string | null>(null);
  const [versions, setVersions] = useState<DocFileVersion[]>([]);
  const [currentFileSha256, setCurrentFileSha256] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [compareBeforeId, setCompareBeforeId] = useState<string>('');
  const [compareAfterId, setCompareAfterId] = useState<string>('');
  const [compareResult, setCompareResult] = useState<DocVersionCompareResponse | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);

  // Trash state (PA-143)
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashEntries, setTrashEntries] = useState<DocTrashEntry[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const tree = useMemo(() => buildTree(entries), [entries]);
  const hasBrief = useMemo(
    () => entries.some((e) => !e.isDir && e.path === 'WORKSPACE.md'),
    [entries],
  );
  const versionStoreAvailable = workspace.versionStoreAvailable !== false;
  const effectiveIndexStatus = indexStatusOverride ?? workspace.indexStatus ?? null;
  const currentIndexMode: DocWorkspaceIndexMode =
    effectiveIndexStatus?.mode ??
    workspace.indexMode ??
    (workspace.indexEnabled === false ? 'off' : 'keyword');

  useEffect(() => {
    setIndexStatusOverride(null);
  }, [workspace.indexStatus, workspace.indexMode, workspace.indexEnabled]);

  // Set webkitdirectory attribute imperatively so TypeScript JSX types stay clean.
  useEffect(() => {
    const el = folderInputRef.current;
    if (el) {
      el.setAttribute('webkitdirectory', '');
      el.setAttribute('directory', '');
    }
  }, []);

  // Scroll/highlight located heading when opening a DOCX or Markdown preview from search.
  useEffect(() => {
    const container = previewHtmlRef.current;
    if (!container || !previewLocation || !previewLocation.startsWith('§')) return;
    const rawHeading = previewLocation.slice(1).trim();
    const strippedHeading = rawHeading.replace(/^\d+(?:\.\d+)*\s+/, '').trim().toLowerCase();
    const headings = Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    for (const h of headings) {
      h.classList.remove('doc-preview-located-heading');
    }
    const target = headings.find((h) => {
      const text = (h.textContent ?? '').trim().toLowerCase();
      return (
        text === rawHeading.toLowerCase() ||
        (strippedHeading.length > 0 && text.includes(strippedHeading))
      );
    });
    if (target) {
      target.classList.add('doc-preview-located-heading');
      target.scrollIntoView?.({ block: 'start' });
    }
  }, [previewData, previewLocation, showDerivedText]);

  const toggleDir = (relPath: string): void => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
  };

  const openPreview = useCallback(
    async (relPath: string, location?: string) => {
      setHistoryPath(null);
      setTrashOpen(false);
      setPreviewPath(relPath);
      setPreviewLocation(location ?? null);
      setPreviewLoading(true);
      setPreviewError(null);
      setActiveSheetIdx(0);
      setShowDerivedText(false);
      try {
        const res = await api.previewDocWorkspaceFile(workspace.id, relPath);
        setPreviewData(res);
        if (location && res.previewKind === 'xlsx_grid' && res.sheets && res.sheets.length > 0) {
          const sheetName = parseSheetNameFromLocation(location);
          if (sheetName) {
            const idx = res.sheets.findIndex(
              (s) => s.name === sheetName || s.name.toLowerCase() === sheetName.toLowerCase(),
            );
            if (idx >= 0) setActiveSheetIdx(idx);
          }
        }
      } catch (err) {
        setPreviewData(null);
        setPreviewError(err instanceof ApiError ? err.message : String(err));
      } finally {
        setPreviewLoading(false);
      }
    },
    [api, workspace.id],
  );

  const openHistory = useCallback(
    async (relPath: string) => {
      setTrashOpen(false);
      setHistoryPath(relPath);
      setHistoryLoading(true);
      setHistoryError(null);
      setCompareResult(null);
      try {
        const res = await api.listDocFileVersions(workspace.id, relPath);
        setVersions(res.versions);
        setCurrentFileSha256(res.currentSha256 ?? null);
        if (res.versions.length >= 2) {
          setCompareAfterId(res.versions[0]!.id);
          setCompareBeforeId(res.versions[1]!.id);
        } else if (res.versions.length === 1) {
          setCompareAfterId(res.versions[0]!.id);
          setCompareBeforeId(res.versions[0]!.id);
        } else {
          setCompareAfterId('');
          setCompareBeforeId('');
        }
      } catch (err) {
        setVersions([]);
        setHistoryError(err instanceof ApiError ? err.message : String(err));
      } finally {
        setHistoryLoading(false);
      }
    },
    [api, workspace.id],
  );

  const openTrash = useCallback(async () => {
    setPreviewPath(null);
    setHistoryPath(null);
    setTrashOpen(true);
    setTrashLoading(true);
    setTrashError(null);
    try {
      const res = await api.listDocWorkspaceTrash(workspace.id);
      setTrashEntries(res.entries);
    } catch (err) {
      setTrashEntries([]);
      setTrashError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setTrashLoading(false);
    }
  }, [api, workspace.id]);

  const handleCompareVersions = async (beforeId: string, afterId: string): Promise<void> => {
    if (!beforeId || !afterId) return;
    setCompareLoading(true);
    setHistoryError(null);
    try {
      const res = await api.compareDocFileVersions(workspace.id, beforeId, afterId);
      setCompareResult(res);
    } catch (err) {
      setHistoryError(err instanceof ApiError ? err.message : 'Could not compare versions.');
    } finally {
      setCompareLoading(false);
    }
  };

  const handleRestoreVersion = async (
    versionId: string,
    target: 'version' | 'previous' = 'version',
  ): Promise<void> => {
    if (!historyPath) return;
    setBusyAction(true);
    setHistoryError(null);
    try {
      await api.restoreDocFileVersion(workspace.id, versionId, { target });
      onRefresh();
      await openHistory(historyPath);
    } catch (err) {
      setHistoryError(err instanceof ApiError ? err.message : 'Could not restore version.');
    } finally {
      setBusyAction(false);
    }
  };

  const handleRestoreFromTrash = async (versionId: string, overwrite = false): Promise<void> => {
    setBusyAction(true);
    setTrashError(null);
    try {
      await api.restoreDocWorkspaceTrash(workspace.id, versionId, { overwrite });
      onRefresh();
      const res = await api.listDocWorkspaceTrash(workspace.id);
      setTrashEntries(res.entries);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && !overwrite) {
        const confirmOverwrite = window.confirm(`${err.message}\n\nOverwrite the existing file?`);
        if (confirmOverwrite) {
          await handleRestoreFromTrash(versionId, true);
          return;
        }
      }
      setTrashError(err instanceof ApiError ? err.message : 'Could not restore file from trash.');
    } finally {
      setBusyAction(false);
    }
  };

  const downloadVersionBlob = (
    versionId: string,
    fileName: string,
    target: 'version' | 'previous' = 'version',
  ): void => {
    const url = api.docFileVersionDownloadUrl(workspace.id, versionId, { target });
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

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
        ...(renamingEntry.sha256 ? { baseVersion: renamingEntry.sha256 } : {}),
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
      await api.deleteDocWorkspaceFile(
        workspace.id,
        deletingEntry.path,
        deletingEntry.sha256 ?? undefined,
      );
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
    setActionError(null);
    try {
      const updated = await api.updateDocWorkspace(workspace.id, {
        autoApproveEdits: !workspace.autoApproveEdits,
      });
      onWorkspaceUpdated?.(updated);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not update workspace setting.');
    }
  };

  const applyIndexMode = async (nextMode: DocWorkspaceIndexMode): Promise<void> => {
    setActionError(null);
    setBusyAction(true);
    try {
      const updated = await api.updateDocWorkspace(workspace.id, { indexMode: nextMode });
      if (updated.indexStatus) {
        setIndexStatusOverride(updated.indexStatus);
      }
      onWorkspaceUpdated?.(updated);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not update index mode.');
    } finally {
      setBusyAction(false);
      setPendingEmbeddingsDisclosure(false);
    }
  };

  const handleIndexModeChange = (nextMode: DocWorkspaceIndexMode): void => {
    if (nextMode === currentIndexMode) return;
    if (nextMode === 'embeddings') {
      setPendingEmbeddingsDisclosure(true);
      return;
    }
    void applyIndexMode(nextMode);
  };

  const handleSearch = async (e?: React.FormEvent): Promise<void> => {
    e?.preventDefault();
    const q = searchQuery.trim();
    if (!q) return;
    setPreviewPath(null);
    setHistoryPath(null);
    setTrashOpen(false);
    setSearchLoading(true);
    setSearchError(null);
    try {
      const res = await api.searchDocWorkspace(workspace.id, { q });
      setSearchResponse(res);
      setIndexStatusOverride(res.indexStatus ?? null);
    } catch (err) {
      setSearchError(err instanceof ApiError ? err.message : 'Search failed.');
    } finally {
      setSearchLoading(false);
    }
  };

  const clearSearch = (): void => {
    setSearchQuery('');
    setSearchResponse(null);
    setSearchError(null);
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
            previewPath === entry.path || historyPath === entry.path ? ' active' : ''
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
                    {!isDir && entry.versionCount !== undefined && entry.versionCount > 0 && (
                      <span
                        className="doc-version-count-badge"
                        title={`${entry.versionCount} recorded version${entry.versionCount === 1 ? '' : 's'}`}
                      >
                        v{entry.versionCount}
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
                  <>
                    <button
                      type="button"
                      className="planner-artifact-btn"
                      onClick={() => onUseInChat(entry.path)}
                      aria-label={`Use ${entry.path} in chat`}
                      title={`Mention @${entry.path} in chat`}
                    >
                      <span className="doc-at-glyph">@</span>
                    </button>
                    <button
                      type="button"
                      className="planner-artifact-btn"
                      onClick={() => void openHistory(entry.path)}
                      aria-label={`Version history for ${entry.path}`}
                      title="Version history"
                    >
                      <Icon name="clock" size={13} />
                    </button>
                  </>
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
                  aria-label={`Move ${entry.path} to trash`}
                  title="Move to trash"
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
            {workspace.autoApproveEdits && (
              <span
                className="doc-auto-approve-badge"
                title="Edits to files inside this workspace run without asking; previous versions are saved automatically."
              >
                Auto-approve edits
              </span>
            )}
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
              className={`planner-artifact-btn${trashOpen ? ' active' : ''}`}
              onClick={() => {
                if (trashOpen) setTrashOpen(false);
                else void openTrash();
              }}
              aria-label="Workspace trash"
              title="Trash (deleted files)"
            >
              <Icon name="trash" size={14} />
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
              disabled={!workspace.autoApproveEdits && !versionStoreAvailable}
              title={
                !versionStoreAvailable
                  ? 'Version store is unavailable; auto-approve edits requires automatic versions'
                  : 'When on, agent file edits inside this workspace run without asking each time (previous versions are saved automatically)'
              }
            >
              {workspace.autoApproveEdits ? 'Auto-approve edits: ON' : 'Auto-approve edits: OFF'}
            </button>
            <label className="doc-workspace-index-mode-label">
              <span>Search index:</span>
              <select
                aria-label="Search index mode"
                value={currentIndexMode}
                disabled={busyAction}
                onChange={(e) => handleIndexModeChange(e.target.value as DocWorkspaceIndexMode)}
              >
                <option value="off">Off</option>
                <option value="keyword">Keyword only</option>
                <option value="embeddings">Keyword + Embeddings</option>
              </select>
            </label>
          </div>
          {effectiveIndexStatus && (
            <div className="doc-workspace-index-meta" data-testid="doc-workspace-index-meta">
              <span className="doc-workspace-index-endpoint">
                {effectiveIndexStatus.embeddingConfigured
                  ? `Embeddings: ${effectiveIndexStatus.embeddingModelId} (${effectiveIndexStatus.embeddingBaseUrl})`
                  : 'Embeddings: endpoint not configured (Settings → Provider & Model)'}
              </span>
              {effectiveIndexStatus.state === 'degraded' || effectiveIndexStatus.degradedError ? (
                <span className="doc-workspace-index-status warn" role="status">
                  Keyword search only — {effectiveIndexStatus.degradedError ?? 'embedding endpoint unavailable'}
                </span>
              ) : currentIndexMode === 'keyword' ? (
                <span className="doc-workspace-index-status info">
                  Keyword search only (embeddings off for this workspace)
                </span>
              ) : currentIndexMode === 'off' ? (
                <span className="doc-workspace-index-status muted">
                  Document search index is off
                </span>
              ) : effectiveIndexStatus.state === 'indexing' || effectiveIndexStatus.pendingEmbeddings > 0 ? (
                <span className="doc-workspace-index-status info" role="status">
                  Indexing embeddings ({effectiveIndexStatus.embeddedCount}/{effectiveIndexStatus.chunkCount} chunks)…
                </span>
              ) : effectiveIndexStatus.embeddingConfigured ? (
                <span className="doc-workspace-index-status ok">
                  Hybrid index ({effectiveIndexStatus.embeddedCount}/{effectiveIndexStatus.chunkCount} chunks)
                </span>
              ) : (
                <span className="doc-workspace-index-status warn" role="status">
                  Keyword search only — configure an embedding endpoint in Settings to enable vectors
                </span>
              )}
            </div>
          )}
        </div>

        <form className="doc-workspace-search-bar" onSubmit={(e) => void handleSearch(e)}>
          <Icon name="search" size={14} />
          <input
            type="search"
            className="doc-workspace-search-input"
            placeholder={
              currentIndexMode === 'off'
                ? 'Enable search index to search documents…'
                : 'Search documents…'
            }
            aria-label="Search workspace documents"
            value={searchQuery}
            disabled={currentIndexMode === 'off'}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <button
            type="submit"
            className="planner-btn small"
            disabled={searchLoading || currentIndexMode === 'off' || !searchQuery.trim()}
          >
            {searchLoading ? 'Searching…' : 'Search'}
          </button>
          {(searchResponse !== null || searchQuery.length > 0) && (
            <button
              type="button"
              className="planner-btn small"
              onClick={clearSearch}
              aria-label="Clear workspace search"
            >
              Clear
            </button>
          )}
        </form>

        {!versionStoreAvailable && (
          <div className="planner-artifacts-error" role="alert">
            Version store is unavailable for this workspace; automatic versions and auto-approve edits are disabled.
          </div>
        )}

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

        {(error || actionError || searchError) && (
          <div className="planner-artifacts-error" role="alert">
            {actionError ?? searchError ?? error}
          </div>
        )}

        {trashOpen ? (
          <div className="doc-workspace-history">
            <div className="doc-workspace-preview-header">
              <button
                type="button"
                className="planner-btn small"
                onClick={() => setTrashOpen(false)}
              >
                <Icon name="chevron-left" size={13} />
                <span>Files</span>
              </button>
              <span className="doc-workspace-preview-title">Trash</span>
              <div className="doc-workspace-preview-actions">
                <button
                  type="button"
                  className="planner-btn small"
                  onClick={() => void openTrash()}
                  disabled={trashLoading}
                >
                  Refresh
                </button>
              </div>
            </div>

            <div className="doc-workspace-preview-body">
              {trashError && <div className="planner-artifacts-error">{trashError}</div>}
              {trashLoading ? (
                <div className="planner-artifacts-loading">Loading trash…</div>
              ) : trashEntries.length === 0 ? (
                <div className="planner-artifacts-empty">
                  <Icon name="trash" size={28} />
                  <p className="planner-artifacts-empty-title">Trash is empty</p>
                  <p className="planner-artifacts-empty-desc">
                    Deleted workspace files appear here and can be restored with their full version history.
                  </p>
                </div>
              ) : (
                <ul className="doc-version-list">
                  {trashEntries.map((item) => (
                    <li key={item.versionId} className="doc-version-item">
                      <div className="doc-version-item-main">
                        <div className="doc-version-item-title">
                          <span className="doc-version-path">{item.relPath}</span>
                          <span className="doc-version-actor">{formatActorLabel(item.actor)}</span>
                          <span className="doc-version-time">{formatTimestamp(item.deletedAt)}</span>
                        </div>
                        <div className="doc-version-summary">
                          {item.summary} · {formatFileSize(item.size)} · <code>{item.sha256.slice(0, 8)}</code>
                        </div>
                      </div>
                      <div className="doc-version-item-actions">
                        <button
                          type="button"
                          className="planner-btn small"
                          disabled={busyAction}
                          onClick={() => void handleRestoreFromTrash(item.versionId, false)}
                        >
                          Restore
                        </button>
                        <button
                          type="button"
                          className="planner-btn small"
                          onClick={() =>
                            downloadVersionBlob(
                              item.versionId,
                              item.relPath.split('/').pop() ?? item.relPath,
                            )
                          }
                          title="Download deleted file"
                        >
                          <Icon name="download" size={13} />
                        </button>
                        <button
                          type="button"
                          className="planner-btn small"
                          onClick={() => void openHistory(item.relPath)}
                          title="View file history"
                        >
                          History
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : historyPath ? (
          <div className="doc-workspace-history">
            <div className="doc-workspace-preview-header">
              <button
                type="button"
                className="planner-btn small"
                onClick={() => {
                  setHistoryPath(null);
                  setCompareResult(null);
                }}
              >
                <Icon name="chevron-left" size={13} />
                <span>Files</span>
              </button>
              <span className="doc-workspace-preview-title" title={historyPath}>
                History: {historyPath}
              </span>
              <div className="doc-workspace-preview-actions">
                <button
                  type="button"
                  className="planner-btn small"
                  onClick={() => void openPreview(historyPath)}
                >
                  Preview
                </button>
              </div>
            </div>

            <div className="doc-workspace-preview-body">
              {historyError && <div className="planner-artifacts-error">{historyError}</div>}
              {historyLoading ? (
                <div className="planner-artifacts-loading">Loading file history…</div>
              ) : versions.length === 0 ? (
                <div className="planner-artifacts-empty">
                  <Icon name="clock" size={28} />
                  <p className="planner-artifacts-empty-title">No versions recorded yet</p>
                  <p className="planner-artifacts-empty-desc">
                    Previous versions are stored automatically before any edit, upload replacement, rename, or delete.
                  </p>
                </div>
              ) : (
                <>
                  {versions.length >= 2 && (
                    <div className="doc-version-compare-bar">
                      <label className="doc-version-compare-label">
                        <span>Before:</span>
                        <select
                          value={compareBeforeId}
                          onChange={(e) => setCompareBeforeId(e.target.value)}
                          aria-label="Before version"
                        >
                          {versions.map((v, i) => (
                            <option key={v.id} value={v.id}>
                              v{versions.length - i} ({v.sha256.slice(0, 7)} · {formatTimestamp(v.createdAt)})
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="doc-version-compare-label">
                        <span>After:</span>
                        <select
                          value={compareAfterId}
                          onChange={(e) => setCompareAfterId(e.target.value)}
                          aria-label="After version"
                        >
                          {versions.map((v, i) => (
                            <option key={v.id} value={v.id}>
                              v{versions.length - i} ({v.sha256.slice(0, 7)} · {formatTimestamp(v.createdAt)})
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="planner-btn small"
                        disabled={compareLoading || !compareBeforeId || !compareAfterId}
                        onClick={() => void handleCompareVersions(compareBeforeId, compareAfterId)}
                      >
                        {compareLoading ? 'Comparing…' : 'Compare'}
                      </button>
                      {compareResult && (
                        <button
                          type="button"
                          className="planner-btn small"
                          onClick={() => setCompareResult(null)}
                        >
                          Close diff
                        </button>
                      )}
                    </div>
                  )}

                  {compareResult && (
                    <div className="doc-version-diff-box">
                      <div className="doc-version-diff-header">
                        <strong>Diff summary:</strong> {compareResult.summary}
                      </div>
                      {compareResult.kind === 'xlsx' && compareResult.cellChanges ? (
                        compareResult.cellChanges.length === 0 ? (
                          <div className="doc-version-diff-empty">No cell differences found.</div>
                        ) : (
                          <div className="doc-workspace-sheet-table-wrap">
                            <table className="doc-workspace-sheet-table doc-version-cell-diff-table">
                              <thead>
                                <tr>
                                  <th>Sheet</th>
                                  <th>Cell</th>
                                  <th>Before</th>
                                  <th>After</th>
                                </tr>
                              </thead>
                              <tbody>
                                {compareResult.cellChanges.map((c, idx) => (
                                  <tr key={`${c.sheet}:${c.cell}:${idx}`}>
                                    <td>{c.sheet}</td>
                                    <td><code>{c.cell}</code></td>
                                    <td className="diff-cell-before">{c.before ?? ''}</td>
                                    <td className="diff-cell-after">{c.after ?? ''}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )
                      ) : compareResult.diffLines && compareResult.diffLines.length > 0 ? (
                        <pre className="doc-version-line-diff">
                          {compareResult.diffLines.map((line, idx) => (
                            <div
                              key={idx}
                              className={`doc-diff-line diff-${line.type}`}
                            >
                              <span className="doc-diff-sign">
                                {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                              </span>
                              <span>{line.text}</span>
                            </div>
                          ))}
                        </pre>
                      ) : (
                        <div className="doc-version-diff-empty">{compareResult.summary}</div>
                      )}
                    </div>
                  )}

                  <ul className="doc-version-list">
                    {versions.map((v, idx) => {
                      const versionNumber = versions.length - idx;
                      const isCurrent = idx === 0 && !v.tombstone && v.sha256 === currentFileSha256;
                      return (
                        <li key={v.id} className="doc-version-item">
                          <div className="doc-version-item-main">
                            <div className="doc-version-item-title">
                              <span className="doc-version-num">v{versionNumber}</span>
                              <span className="doc-version-actor">{formatActorLabel(v.actor)}</span>
                              <span className="doc-version-time">{formatTimestamp(v.createdAt)}</span>
                              {isCurrent && <span className="doc-status-badge status-extracted">current</span>}
                              {v.tombstone && <span className="doc-status-badge status-failed">deleted</span>}
                            </div>
                            <div className="doc-version-summary">
                              {v.summary} · {formatFileSize(v.size)} · <code>{v.sha256.slice(0, 8)}</code>
                            </div>
                          </div>
                          <div className="doc-version-item-actions">
                            <button
                              type="button"
                              className="planner-btn small"
                              disabled={busyAction}
                              onClick={() => void handleRestoreVersion(v.id, 'version')}
                              title="Restore this version (creates a new version entry)"
                            >
                              Restore
                            </button>
                            {v.prevSha256 && v.prevSha256 !== v.sha256 && (
                              <button
                                type="button"
                                className="planner-btn small"
                                disabled={busyAction}
                                onClick={() => void handleRestoreVersion(v.id, 'previous')}
                                title="Restore the state from immediately before this change"
                              >
                                Restore before
                              </button>
                            )}
                            {idx + 1 < versions.length && (
                              <button
                                type="button"
                                className="planner-btn small"
                                disabled={compareLoading}
                                onClick={() => {
                                  const prevVer = versions[idx + 1]!;
                                  setCompareBeforeId(prevVer.id);
                                  setCompareAfterId(v.id);
                                  void handleCompareVersions(prevVer.id, v.id);
                                }}
                                title="Compare with previous version"
                              >
                                Diff
                              </button>
                            )}
                            <button
                              type="button"
                              className="planner-btn small"
                              onClick={() =>
                                downloadVersionBlob(
                                  v.id,
                                  `${v.relPath.split('/').pop() ?? v.relPath}`,
                                  'version',
                                )
                              }
                              title="Download this version"
                            >
                              <Icon name="download" size={13} />
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          </div>
        ) : previewPath ? (
          <div className="doc-workspace-preview">
            <div className="doc-workspace-preview-header">
              <button
                type="button"
                className="planner-btn small"
                onClick={() => {
                  setPreviewPath(null);
                  setPreviewLocation(null);
                  setPreviewData(null);
                  setPreviewError(null);
                }}
              >
                <Icon name="chevron-left" size={13} />
                <span>{searchResponse !== null ? 'Search' : 'Files'}</span>
              </button>
              <span className="doc-workspace-preview-title" title={previewPath}>
                {previewPath}
                {previewLocation && (
                  <span className="doc-preview-location-badge" title={`Located at ${previewLocation}`}>
                    {previewLocation}
                  </span>
                )}
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
                  onClick={() => void openHistory(previewPath)}
                  title="View version history"
                >
                  <Icon name="clock" size={13} />
                  <span>History</span>
                </button>
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
                (() => {
                  const basePdfUrl = api.docWorkspaceFileDownloadUrl(workspace.id, previewData.path, true);
                  const pdfPage = parsePdfPageFromLocation(previewLocation);
                  const pdfSrc = pdfPage !== null ? `${basePdfUrl}#page=${pdfPage}` : basePdfUrl;
                  return (
                    <iframe
                      className="doc-workspace-pdf-frame"
                      src={pdfSrc}
                      title={`Preview ${previewData.path}`}
                    />
                  );
                })()
              ) : previewData.previewKind === 'docx_html' ? (
                <div
                  ref={previewHtmlRef}
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
                  ref={previewHtmlRef}
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
        ) : searchResponse !== null ? (
          <div className="doc-workspace-search-results" data-testid="doc-workspace-search-results">
            <div className="doc-search-status-header">
              {searchResponse.mode === 'degraded' ? (
                <div className="doc-search-status-banner warn" role="status">
                  Keyword search only — {searchResponse.degradedReason ?? 'embedding endpoint is unavailable.'}
                </div>
              ) : searchResponse.mode === 'keyword' ? (
                <div className="doc-search-status-banner info" role="status">
                  Keyword search only — {searchResponse.degradedReason ?? 'embeddings are off for this workspace.'}
                </div>
              ) : searchResponse.mode === 'disabled' ? (
                <div className="doc-search-status-banner warn" role="status">
                  {searchResponse.degradedReason ?? 'Search index is turned off for this workspace.'}
                </div>
              ) : (
                <div className="doc-search-status-banner ok" role="status">
                  Hybrid search (FTS5 + embeddings) · {searchResponse.hits.length} result
                  {searchResponse.hits.length === 1 ? '' : 's'}
                </div>
              )}
            </div>
            {searchResponse.hits.length === 0 ? (
              <div className="planner-artifacts-empty">
                <Icon name="search" size={28} />
                <p className="planner-artifacts-empty-title">No matching chunks</p>
                <p className="planner-artifacts-empty-desc">
                  No document sections matched &ldquo;{searchResponse.query}&rdquo;.
                </p>
              </div>
            ) : (
              <ul className="doc-search-results-list">
                {searchResponse.hits.map((hit: DocSearchResultHit) => (
                  <li key={`${hit.path}:${hit.ordinal}`} className="doc-search-hit-item">
                    <button
                      type="button"
                      className="doc-search-hit-btn"
                      onClick={() => void openPreview(hit.path, hit.location)}
                    >
                      <div className="doc-search-hit-head">
                        <span className="doc-search-hit-path">{hit.path}</span>
                        <span className="doc-search-hit-location">{hit.location}</span>
                        <span className={`doc-search-hit-match match-${hit.matchType}`}>
                          {hit.matchType}
                        </span>
                      </div>
                      <p className="doc-search-hit-snippet">{hit.snippet}</p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
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

        {pendingEmbeddingsDisclosure && (
          <ConfirmDialog
            title={`Turn on document embeddings for ${workspace.name}?`}
            body={
              `Turning on embeddings sends extracted document text from this workspace to the configured embedding endpoint ` +
              `(${effectiveIndexStatus?.embeddingBaseUrl || 'configured in Settings → Provider & Model'}, ` +
              `model: ${effectiveIndexStatus?.embeddingModelId || 'not configured'}) ` +
              `to build semantic search vectors. Keep "Keyword only" if document text should stay strictly local to SQLite FTS5.`
            }
            confirmLabel={busyAction ? 'Enabling…' : 'Enable embeddings'}
            busy={busyAction}
            onConfirm={() => void applyIndexMode('embeddings')}
            onCancel={() => setPendingEmbeddingsDisclosure(false)}
          />
        )}

        {deletingEntry && (
          <ConfirmDialog
            title={`Move ${deletingEntry.isDir ? 'folder' : 'file'} to trash?`}
            body={`Move "${deletingEntry.path}" to the workspace trash? You can restore it anytime from the Trash view or file history.`}
            confirmLabel={busyAction ? 'Moving to trash…' : 'Move to trash'}
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

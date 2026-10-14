/**
 * Human-readable metadata and functional groupings for Pocket Agent planner tools.
 *
 * Replaces verbose model docstrings with concise one-line descriptions in settings
 * while keeping the complete LLM documentation accessible via hover tooltips.
 */

export interface ToolMeta {
  shortDescription: string;
  category: ToolCategory;
}

export type ToolCategory =
  | 'Files & Workspaces'
  | 'Sessions & Subagents'
  | 'Terminal & Execution'
  | 'Web & Search'
  | 'Memory'
  | 'Integrations'
  | 'Settings & Administration';

export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  'Files & Workspaces',
  'Sessions & Subagents',
  'Terminal & Execution',
  'Web & Search',
  'Memory',
  'Integrations',
  'Settings & Administration',
];

export const TOOL_METADATA: Record<string, ToolMeta> = {
  // Files & Workspaces
  list_workspaces: {
    shortDescription: 'List available project folders and git worktrees',
    category: 'Files & Workspaces',
  },
  read_file: {
    shortDescription: 'Read file contents from a workspace',
    category: 'Files & Workspaces',
  },
  write_file: {
    shortDescription: 'Create or overwrite files in a workspace',
    category: 'Files & Workspaces',
  },
  edit_file: {
    shortDescription: 'Apply exact text replacements to a file in a workspace',
    category: 'Files & Workspaces',
  },
  sheet_info: {
    shortDescription: 'Inspect .xlsx/.xlsm sheets, ranges, tables, charts, pivots, and macros',
    category: 'Files & Workspaces',
  },
  sheet_read: {
    shortDescription: 'Read cell values, expanded formulas, number formats, merges, and comments',
    category: 'Files & Workspaces',
  },
  sheet_find: {
    shortDescription: 'Search cell values or formulas across all sheets in a workbook',
    category: 'Files & Workspaces',
  },
  sheet_check: {
    shortDescription: 'Recalculate a workbook copy and report formula errors and stale caches',
    category: 'Files & Workspaces',
  },
  sheet_edit: {
    shortDescription: 'Patch .xlsx/.xlsm cells, tables, or sheets in place or into a new file',
    category: 'Files & Workspaces',
  },
  doc_read: {
    shortDescription: 'Read .docx paragraphs, headings, tables, comments, and tracked changes',
    category: 'Files & Workspaces',
  },
  doc_edit: {
    shortDescription: 'Edit .docx in place with Word tracked changes, direct edits, or comments',
    category: 'Files & Workspaces',
  },
  create_sheet: {
    shortDescription: 'Create a new .xlsx workbook with sheets, formulas, and number formats',
    category: 'Files & Workspaces',
  },
  create_doc: {
    shortDescription: 'Create a new .docx document from Markdown and an optional .docx template',
    category: 'Files & Workspaces',
  },
  export_pdf: {
    shortDescription: 'Export a .docx, .xlsx, or .pptx document to PDF via headless LibreOffice',
    category: 'Files & Workspaces',
  },
  find_files: {
    shortDescription: 'Search for files matching name or glob pattern',
    category: 'Files & Workspaces',
  },
  search_documents: {
    shortDescription: 'Hybrid keyword + semantic search over workspace documents with located snippets',
    category: 'Files & Workspaces',
  },
  grep_files: {
    shortDescription: 'Search file contents using exact strings or regular expressions',
    category: 'Files & Workspaces',
  },
  rename_file: {
    shortDescription: 'Rename or move files and directories in a workspace',
    category: 'Files & Workspaces',
  },
  delete_file: {
    shortDescription: 'Delete a file in a workspace',
    category: 'Files & Workspaces',
  },
  mkdir: {
    shortDescription: 'Create directories in a workspace',
    category: 'Files & Workspaces',
  },
  rmdir: {
    shortDescription: 'Remove empty directories in a workspace',
    category: 'Files & Workspaces',
  },
  delete_worktree: {
    shortDescription: 'Delete a git worktree and clean up branches',
    category: 'Files & Workspaces',
  },

  // Sessions & Subagents
  list_sessions: {
    shortDescription: 'List active and past coding sessions',
    category: 'Sessions & Subagents',
  },
  read_session_output: {
    shortDescription: "Inspect a coding session's transcript and progress",
    category: 'Sessions & Subagents',
  },
  list_subagents: {
    shortDescription: 'List subagent conversations spawned by this chat',
    category: 'Sessions & Subagents',
  },
  get_subagent_status: {
    shortDescription: 'Check status and latest response of a subagent',
    category: 'Sessions & Subagents',
  },
  send_instruction: {
    shortDescription: 'Send an instruction or prompt to a coding session',
    category: 'Sessions & Subagents',
  },
  start_subagent_session: {
    shortDescription: 'Spawn a new subagent or coding session',
    category: 'Sessions & Subagents',
  },
  stop_subagent: {
    shortDescription: 'Cancel a running subagent turn or session',
    category: 'Sessions & Subagents',
  },
  check_back_in: {
    shortDescription: 'Pause and wait for subagent tasks to complete',
    category: 'Sessions & Subagents',
  },

  // Terminal & Execution
  bash: {
    shortDescription: 'Execute shell commands inside the workspace',
    category: 'Terminal & Execution',
  },
  exec_command: {
    shortDescription: 'Run commands in a managed interactive session',
    category: 'Terminal & Execution',
  },

  // Web & Search
  web_search: {
    shortDescription: 'Search the web using DuckDuckGo',
    category: 'Web & Search',
  },
  url_fetch: {
    shortDescription: 'Fetch and parse content from a web URL',
    category: 'Web & Search',
  },

  // Memory
  memory_search: {
    shortDescription: 'Search cross-turn memory notes by semantic similarity',
    category: 'Memory',
  },
  memory_save: {
    shortDescription: 'Save an important fact or preference to long-term memory',
    category: 'Memory',
  },

  // Integrations
  list_telegram_links: {
    shortDescription: 'List paired Telegram user accounts',
    category: 'Integrations',
  },
  send_telegram_message: {
    shortDescription: 'Send notification messages to a Telegram chat',
    category: 'Integrations',
  },

  // Settings & Administration
  get_current_time: {
    shortDescription: 'Get current system date, time, and timezone',
    category: 'Settings & Administration',
  },
  write_skill: {
    shortDescription: 'Create or update reusable skills in .skills/',
    category: 'Settings & Administration',
  },
  read_settings: {
    shortDescription: 'Inspect server configuration settings',
    category: 'Settings & Administration',
  },
  update_settings: {
    shortDescription: 'Update Pocket Agent settings',
    category: 'Settings & Administration',
  },
  update_webhook: {
    shortDescription: 'Configure webhook endpoints and subscriptions',
    category: 'Settings & Administration',
  },
  update_cron_job: {
    shortDescription: 'Configure scheduled unattended agent runs',
    category: 'Settings & Administration',
  },
  update_custom_claude_provider: {
    shortDescription: 'Configure custom Claude endpoint providers',
    category: 'Settings & Administration',
  },
  update_telegram_bot: {
    shortDescription: 'Configure Telegram bot token and settings',
    category: 'Settings & Administration',
  },
};

/** Get the concise description for a tool, falling back to a truncated version of the full docstring. */
export function getToolShortDescription(name: string, fallbackDescription?: string): string {
  const meta = TOOL_METADATA[name];
  if (meta) return meta.shortDescription;
  if (!fallbackDescription) return '';
  const firstSentence = fallbackDescription.split(/\. |\n/)[0]?.trim();
  return firstSentence && firstSentence.length <= 80 ? firstSentence : `${fallbackDescription.slice(0, 77)}…`;
}

/** Get the functional category for a tool. */
export function getToolCategory(name: string): ToolCategory {
  return TOOL_METADATA[name]?.category ?? 'Settings & Administration';
}

export interface GroupedTools<T> {
  category: ToolCategory;
  tools: T[];
}

/**
 * Group tools into functional categories preserving defined category order.
 */
export function groupToolsByCategory<T extends { name: string }>(tools: T[]): GroupedTools<T>[] {
  const groups = new Map<ToolCategory, T[]>();
  for (const cat of TOOL_CATEGORIES) {
    groups.set(cat, []);
  }

  for (const tool of tools) {
    const cat = getToolCategory(tool.name);
    const list = groups.get(cat);
    if (list) {
      list.push(tool);
    } else {
      groups.set(cat, [tool]);
    }
  }

  const result: GroupedTools<T>[] = [];
  for (const cat of TOOL_CATEGORIES) {
    const list = groups.get(cat);
    if (list && list.length > 0) {
      result.push({ category: cat, tools: list });
    }
  }
  return result;
}

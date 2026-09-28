import type {
  HubTemplateKind,
  PocketAgentExportEnvelope,
  PocketAgentExportKind,
} from '@pocketagent/protocol';
import {
  createExportEnvelope,
  parseExportEnvelope,
  type ExportParseResult,
} from '@pocketagent/protocol';

/**
 * Downloads a JSON file in the browser using a temporary anchor element.
 */
export function downloadJsonFile(filename: string, envelope: PocketAgentExportEnvelope): void {
  const json = JSON.stringify(envelope, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Reads and parses a File object as JSON.
 */
export async function readJsonFile(file: File): Promise<unknown> {
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse "${file.name}" as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Formats a clean, predictable filename for an export.
 * e.g. `pocketagent-cron-nightly-review-20260928-053000.json`
 */
export function formatExportFilename(kind: string, name?: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  
  const cleanName = name
    ? name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
    : '';

  const prefix = `pocketagent-${kind}`;
  return cleanName ? `${prefix}-${cleanName}-${stamp}.json` : `${prefix}-${stamp}.json`;
}

/**
 * Creates an envelope, formats a filename, and prompts the browser to download it.
 */
export function exportToJsonFile(
  kind: PocketAgentExportKind,
  data: unknown,
  name?: string,
): void {
  const envelope = createExportEnvelope(kind, data, name);
  const filename = formatExportFilename(kind, name);
  downloadJsonFile(filename, envelope);
}

/**
 * Reads a File and validates it as a PocketAgent export envelope,
 * ensuring the kind matches expectedKind if specified.
 */
export async function importFromJsonFile<T = unknown>(
  file: File,
  expectedKind?: PocketAgentExportKind,
): Promise<ExportParseResult<T>> {
  try {
    const raw = await readJsonFile(file);
    return parseExportEnvelope<T>(raw, expectedKind);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface HubTemplateDraft {
  kind: HubTemplateKind;
  name: string;
  description?: string;
  payload: unknown;
}

/**
 * Converts a compatible export envelope into a Hub Template creation payload.
 * Returns null if the export envelope kind cannot be made into a Hub template.
 */
export function exportEnvelopeToHubTemplate(
  envelope: PocketAgentExportEnvelope,
): HubTemplateDraft | null {
  switch (envelope.kind) {
    case 'hub-template': {
      const data = envelope.data as { kind: HubTemplateKind; name: string; description?: string; payload: unknown };
      return {
        kind: data.kind,
        name: data.name,
        ...(data.description !== undefined ? { description: data.description } : {}),
        payload: data.payload,
      };
    }
    case 'pocket-agent': {
      const data = envelope.data as {
        name: string;
        defaultModelId?: string | null;
        identityPrompt?: string | null;
        memoryEnabled?: boolean;
        mcpEnabled?: boolean;
        disabledTools?: string[];
      };
      return {
        kind: 'pocket-agent',
        name: data.name,
        description: 'Imported from Pocket Agent export',
        payload: {
          name: data.name,
          defaultModelId: data.defaultModelId ?? null,
          identityPrompt: data.identityPrompt ?? null,
          memoryEnabled: data.memoryEnabled ?? true,
          mcpEnabled: data.mcpEnabled ?? true,
          disabledTools: data.disabledTools ?? [],
        },
      };
    }
    case 'planner-endpoint': {
      return {
        kind: 'planner-endpoint',
        name: envelope.name || 'Imported LLM Endpoint',
        description: 'Imported from LLM Endpoint export',
        payload: envelope.data,
      };
    }
    case 'mcp-registry': {
      if (Array.isArray(envelope.data)) {
        const first = envelope.data[0] as { name: string; description?: string | null } | undefined;
        if (!first) return null;
        return {
          kind: 'mcp-registry',
          name: first.name,
          ...(first.description ? { description: first.description } : {}),
          payload: first,
        };
      }
      const data = envelope.data as { name: string; description?: string | null };
      return {
        kind: 'mcp-registry',
        name: data.name,
        ...(data.description ? { description: data.description } : {}),
        payload: envelope.data,
      };
    }
    case 'claude-provider': {
      const data = envelope.data as { name: string };
      return {
        kind: 'claude-provider',
        name: data.name,
        description: 'Imported from Claude Provider export',
        payload: envelope.data,
      };
    }
    case 'skill': {
      const data = envelope.data as { name: string; description?: string };
      return {
        kind: 'skill',
        name: data.name,
        ...(data.description ? { description: data.description } : {}),
        payload: envelope.data,
      };
    }
    default:
      return null;
  }
}

/**
 * Converts an export envelope into one or more Hub template drafts.
 * Handles single-item exports as well as batch exports (such as all MCP registries).
 */
export function exportEnvelopeToHubTemplates(
  envelope: PocketAgentExportEnvelope,
): HubTemplateDraft[] {
  if (envelope.kind === 'mcp-registry' && Array.isArray(envelope.data)) {
    return (envelope.data as Array<{ name: string; description?: string | null }>).map((reg) => ({
      kind: 'mcp-registry',
      name: reg.name,
      ...(reg.description ? { description: reg.description } : {}),
      payload: reg,
    }));
  }
  const single = exportEnvelopeToHubTemplate(envelope);
  return single !== null ? [single] : [];
}


import { z } from 'zod';
import { SessionTransport } from './agent-events.js';
import { AgentSetupState } from './agent-install.js';

/**
 * PA-133: per-backend capability card (`GET /api/capabilities` and the
 * `get_capabilities` MCP tool).
 *
 * Versioned separately from `PROTOCOL_VERSION` so the Hub can recognise an
 * older card shape when probing a mixed fleet without rejecting the host as
 * protocol-incompatible.
 */
export const CAPABILITIES_VERSION = 1;

/**
 * Fixed list of notable executables a backend probes for on disk.
 *
 * The browser and MCP callers never supply an executable name or path to
 * probe, and the card never returns resolved file paths or `PATH` — only which
 * entries from this closed enum exist in `executableSearchDirs`.
 */
export const NOTABLE_EXECUTABLES = [
  'xcodebuild',
  'swift',
  'xcrun',
  'playwright-cli',
  'docker',
  'git',
  'node',
  'python3',
  'cargo',
  'go',
] as const;

export const NotableExecutable = z.enum(NOTABLE_EXECUTABLES);
export type NotableExecutable = z.infer<typeof NotableExecutable>;

/**
 * Executables that are meaningful only on macOS (`darwin`) and are never
 * probed or reported on Linux or other platforms, even if a shim with that
 * name exists on disk.
 */
export const DARWIN_ONLY_EXECUTABLES: ReadonlySet<NotableExecutable> = new Set<NotableExecutable>([
  'xcodebuild',
  'xcrun',
]);

/**
 * Operator-declared tag slug on a host capability card (e.g. `ios-signing`,
 * `gpu`, `photo-archive`).
 */
export const HOST_CAPABILITY_TAG_PATTERN = /^[a-z0-9](?:[a-z0-9-_]{0,38}[a-z0-9])?$/;

export const HostCapabilityTag = z.string().regex(HOST_CAPABILITY_TAG_PATTERN, {
  message: 'Tags must be 1–40 lowercase letters, digits, hyphens or underscores.',
});
export type HostCapabilityTag = z.infer<typeof HostCapabilityTag>;

export const HostCapabilityAgent = z.object({
  id: z.string(),
  displayName: z.string(),
  available: z.boolean(),
  setupState: AgentSetupState,
  setupDetail: z.string().nullable(),
  transports: z.array(SessionTransport),
  structured: z.boolean(),
});
export type HostCapabilityAgent = z.infer<typeof HostCapabilityAgent>;

export const HostCapabilityProject = z.object({
  path: z.string(),
  name: z.string(),
  label: z.string(),
  gitRemoteUrl: z.string().nullable(),
});
export type HostCapabilityProject = z.infer<typeof HostCapabilityProject>;

export const HostCapabilityPocketAgent = z.object({
  id: z.string(),
  name: z.string(),
  defaultModelId: z.string().nullable(),
  identityPrompt: z.string().nullable(),
  enabledTools: z.array(z.string()),
  skills: z.array(z.string()),
});
export type HostCapabilityPocketAgent = z.infer<typeof HostCapabilityPocketAgent>;

export const HostCapabilities = z.object({
  capabilitiesVersion: z.number().int().positive(),
  platform: z.string(),
  arch: z.string(),
  osVersion: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  agents: z.array(HostCapabilityAgent),
  executables: z.array(NotableExecutable),
  projects: z.array(HostCapabilityProject),
  pocketAgents: z.array(HostCapabilityPocketAgent),
});
export type HostCapabilities = z.infer<typeof HostCapabilities>;

import {
  isMcpRegistryBundle,
  mcpRegistriesFromPayload,
  parseTemplatePayload,
  type CustomClaudeProviderKind,
  type HubTemplateKind,
  type HubTemplatePayload,
  type McpAuthKind,
  type McpTransportKind,
  type PlannerProviderTemplateModel,
  type ProvisioningOutcome,
  type SingleMcpRegistryTemplatePayload,
} from '@pocketagent/protocol';

/**
 * Presentation and form plumbing for Hub config templates (PA-70).
 *
 * Pure functions in `agent/` rather than inside the two pages, for the reason
 * `cron-format.ts` already sits here: the list and the editor both need the
 * same kind labels and the same words for an outcome, and the draft⇄payload
 * conversion is the part of the editor most worth reading on its own — every
 * template payload schema has at least one nullable or array field, and
 * "empty field means `null`" is a decision, not an accident of typing.
 */

export interface TemplateKindInfo {
  readonly kind: HubTemplateKind;
  readonly label: string;
  /** One line, shown while choosing a kind — a kind cannot be changed later. */
  readonly blurb: string;
  /**
   * What instantiating this kind does to a host beyond adding a row, or null
   * when there is nothing to disclose.
   *
   * Rendered on every visit to the editor rather than only at the moment of
   * instantiation, the same rule `SessionInfo.skipPermissionsEnabled` follows:
   * the consequence belongs to the template, so it has to be visible while the
   * template is being written, not just while it is being pushed.
   */
  readonly disclosure: string | null;
}

/** Order matches `HubTemplateKind`'s own, so the two lists read as one. */
export const TEMPLATE_KINDS: readonly TemplateKindInfo[] = [
  {
    kind: 'pocket-agent',
    label: 'Pocket Agent',
    blurb: 'An agent, its identity prompt and its tool subset. Its directory is always app-created scratch space on the receiving host.',
    disclosure: null,
  },
  {
    kind: 'mcp-registry',
    label: 'MCP registry',
    blurb: 'An MCP endpoint, its transport and its auth header name. The credential is asked for per host.',
    disclosure:
      'Creating an MCP registry runs a connection check on the receiving host, so instantiating this makes that machine dial this endpoint.',
  },
  {
    kind: 'claude-provider',
    label: 'Custom Claude provider',
    blurb: 'Claude Code pointed at a third-party Anthropic-compatible endpoint. The API key is asked for per host.',
    disclosure:
      'A provider routes prompts and repository contents to this endpoint, and its cost figures are computed with Anthropic pricing, so they will be wrong.',
  },
  {
    kind: 'skill',
    label: 'Skill',
    blurb: 'One SKILL.md — frontmatter and body — added to the receiving host’s global skill catalog.',
    disclosure:
      'A skill template carries one SKILL.md and nothing else. A skill directory can hold auxiliary files, and those are not copied.',
  },
  {
    kind: 'planner-provider',
    label: 'Pocket Agent provider',
    blurb: 'An OpenAI-compatible Pocket Agent LLM provider and its model catalog. The API key is asked for per host.',
    disclosure:
      'A provider routes Pocket Agent prompts and tool outputs to this endpoint.',
  },
];

export function kindInfo(kind: HubTemplateKind): TemplateKindInfo {
  // Non-null by construction: `TEMPLATE_KINDS` covers the closed enum, and a
  // kind added to the protocol without a row here is a typecheck failure in
  // the pages that switch on it rather than a silent blank label.
  return TEMPLATE_KINDS.find((entry) => entry.kind === kind) ?? TEMPLATE_KINDS[0]!;
}

/**
 * Which of the three status colours an outcome reads as.
 *
 * `skipped` and `conflict` are deliberately *warnings* rather than errors:
 * nothing was written, which is the correct and requested behaviour without a
 * confirmed overwrite, and colouring them red would teach an operator to
 * ignore red.
 */
export function outcomeTone(outcome: ProvisioningOutcome): 'ok' | 'warn' | 'danger' {
  switch (outcome) {
    case 'provisioned':
    case 'overwritten':
      return 'ok';
    case 'skipped':
    case 'conflict':
    case 'unsupported':
      return 'warn';
    case 'failed':
      return 'danger';
  }
}

/**
 * Every field any kind's form has, flat and all-strings.
 *
 * One draft shape for five kinds rather than five, because the alternative is
 * five `useState` sets in one component and a `switch` around every setter.
 * The cost is fields a given kind ignores, which is why `payloadFrom` reads
 * only the ones its own kind declares — a leftover value from a kind the
 * operator was looking at first can never reach a request.
 *
 * All-strings is load-bearing for the array and nullable fields: parsing on
 * every keystroke would rewrite what is being typed (a trailing newline in a
 * model list, a half-deleted URL), so the text is kept verbatim and converted
 * once, at save.
 */
export interface TemplateDraft {
  name: string;
  defaultModelId: string;
  identityPrompt: string;
  memoryEnabled: boolean;
  mcpEnabled: boolean;
  /** One tool name per line. */
  disabledTools: string;
  transport: McpTransportKind;
  url: string;
  authKind: McpAuthKind;
  headerName: string;
  description: string;
  enabled: boolean;
  providerKind: CustomClaudeProviderKind;
  baseUrl: string;
  /** One model per line; for `planner-provider`, `id | label`. */
  models: string;
  defaultModel: string;
  smallModel: string;
  allowUnattended: boolean;
  slug: string;
  body: string;
  isBundle?: boolean;
  mcpRegistries?: SingleMcpRegistryTemplatePayload[];
  plannerModels?: PlannerProviderTemplateModel[];
}

const EMPTY_DRAFT: TemplateDraft = {
  name: '',
  defaultModelId: '',
  identityPrompt: '',
  memoryEnabled: true,
  mcpEnabled: true,
  disabledTools: '',
  transport: 'streamable_http',
  url: '',
  authKind: 'none',
  headerName: '',
  description: '',
  enabled: true,
  providerKind: 'claude-compatible',
  baseUrl: '',
  models: '',
  defaultModel: '',
  smallModel: '',
  allowUnattended: false,
  slug: '',
  body: '',
};

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** `''` means "not set" for every nullable field in every payload schema. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** A blank draft for a new template of `kind`. */
export function emptyDraft(): TemplateDraft {
  return { ...EMPTY_DRAFT };
}

/** The draft an existing template's payload hydrates into. */
export function draftFrom(spec: HubTemplatePayload): TemplateDraft {
  const draft = emptyDraft();
  switch (spec.kind) {
    case 'pocket-agent':
      return {
        ...draft,
        name: spec.payload.name,
        defaultModelId: spec.payload.defaultModelId ?? '',
        identityPrompt: spec.payload.identityPrompt ?? '',
        memoryEnabled: spec.payload.memoryEnabled,
        mcpEnabled: spec.payload.mcpEnabled,
        disabledTools: spec.payload.disabledTools.join('\n'),
      };
    case 'mcp-registry': {
      const isBundle = isMcpRegistryBundle(spec.payload) && spec.payload.registries.length > 1;
      const list = mcpRegistriesFromPayload(spec.payload);
      const first = list[0] ?? {
        name: '',
        transport: 'streamable_http' as const,
        url: '',
        authKind: 'none' as const,
        headerName: null,
        description: null,
        enabled: true,
      };
      return {
        ...draft,
        name: first.name,
        transport: first.transport,
        url: first.url,
        authKind: first.authKind,
        headerName: first.headerName ?? '',
        description: first.description ?? '',
        enabled: first.enabled,
        isBundle,
        mcpRegistries: list,
      };
    }
    case 'claude-provider':
      return {
        ...draft,
        name: spec.payload.name,
        providerKind: spec.payload.providerKind,
        baseUrl: spec.payload.baseUrl,
        models: spec.payload.models.join('\n'),
        defaultModel: spec.payload.defaultModel,
        smallModel: spec.payload.smallModel ?? '',
        allowUnattended: spec.payload.allowUnattended,
      };
    case 'skill':
      return {
        ...draft,
        slug: spec.payload.slug,
        name: spec.payload.name,
        description: spec.payload.description,
        body: spec.payload.body,
      };
    case 'planner-provider':
      return {
        ...draft,
        name: spec.payload.label,
        baseUrl: spec.payload.baseUrl,
        allowUnattended: spec.payload.allowUnattended,
        models: spec.payload.models
          .map((model) => (model.label === model.modelId ? model.modelId : `${model.modelId} | ${model.label}`))
          .join('\n'),
        plannerModels: spec.payload.models,
      };
  }
}

/** The object a draft posts as `payload`, before its kind's schema sees it. */
export function payloadFrom(kind: HubTemplateKind, draft: TemplateDraft): unknown {
  switch (kind) {
    case 'pocket-agent':
      return {
        name: draft.name.trim(),
        defaultModelId: orNull(draft.defaultModelId),
        identityPrompt: orNull(draft.identityPrompt),
        memoryEnabled: draft.memoryEnabled,
        mcpEnabled: draft.mcpEnabled,
        disabledTools: lines(draft.disabledTools),
      };
    case 'mcp-registry':
      if (draft.isBundle && draft.mcpRegistries && draft.mcpRegistries.length > 1) {
        return {
          registries: draft.mcpRegistries,
        };
      }
      return {
        name: draft.name.trim(),
        transport: draft.transport,
        url: draft.url.trim(),
        authKind: draft.authKind,
        // Only meaningful for `header` auth, and carried as null otherwise so
        // switching the auth kind cannot leave a stale header name in the row
        // that `secretHolesFor` would then name in its own label.
        headerName: draft.authKind === 'header' ? orNull(draft.headerName) : null,
        description: orNull(draft.description),
        enabled: draft.enabled,
      };
    case 'claude-provider':
      return {
        name: draft.name.trim(),
        providerKind: draft.providerKind,
        baseUrl: draft.baseUrl.trim(),
        models: lines(draft.models),
        defaultModel: draft.defaultModel.trim(),
        smallModel: orNull(draft.smallModel),
        allowUnattended: draft.allowUnattended,
      };
    case 'skill':
      return {
        slug: draft.slug.trim(),
        name: draft.name.trim(),
        description: draft.description.trim(),
        // Not trimmed: a SKILL.md body's leading whitespace is content.
        body: draft.body,
      };
    case 'planner-provider': {
      const existingByModelId = new Map(
        (draft.plannerModels ?? []).map((m) => [m.modelId, m]),
      );
      return {
        label: draft.name.trim(),
        kind: 'openai-compatible' as const,
        baseUrl: draft.baseUrl.trim(),
        allowUnattended: draft.allowUnattended,
        models: lines(draft.models).map((line) => {
          const [modelId, label] = line.split('|');
          const id = (modelId ?? '').trim();
          const resolvedLabel = (label ?? '').trim() === '' ? id : (label ?? '').trim();
          const prev = existingByModelId.get(id);
          return prev
            ? { ...prev, modelId: id, label: resolvedLabel }
            : { modelId: id, label: resolvedLabel };
        }),
      };
    }
  }
}

/**
 * The draft as a validated payload, or the schema's own complaint.
 *
 * Goes through `parseTemplatePayload` — the same function the Hub's routes call
 * — rather than a second set of checks here, which is the whole reason those
 * schemas live in `packages/protocol`: an editor that validated differently
 * would let through exactly what the Hub then refuses.
 */
export function validateDraft(
  kind: HubTemplateKind,
  draft: TemplateDraft,
): { ok: true; value: HubTemplatePayload } | { ok: false; message: string } {
  return parseTemplatePayload(kind, payloadFrom(kind, draft), draft.name.trim() || undefined);
}

/**
 * A template id the editor can open before any row exists.
 *
 * `kind` has to be chosen *before* the form can be drawn — the five kinds have
 * almost no fields in common — and `UpdateHubTemplateRequest` deliberately
 * cannot change it afterwards, so it cannot be a field inside the editor
 * either. Carrying it in the route segment is what lets the editor follow
 * `CronJobEditorPage`'s `'new'` convention (nothing is written until Save, so
 * an abandoned draft leaves no row on the Hub) without a second route
 * variant for "new, of this kind".
 */
export function newTemplateId(kind: HubTemplateKind): string {
  return `new:${kind}`;
}

export function parseTemplateId(
  templateId: string,
): { mode: 'new'; kind: HubTemplateKind } | { mode: 'existing' } {
  const match = /^new:(.+)$/.exec(templateId);
  if (!match?.[1]) return { mode: 'existing' };
  const kind = TEMPLATE_KINDS.find((entry) => entry.kind === match[1]);
  // An unknown kind in the URL (a hand-edited hash, a link from a newer build)
  // reads as an existing id, which then 404s legibly rather than rendering a
  // form for a kind this bundle has no fields for.
  return kind ? { mode: 'new', kind: kind.kind } : { mode: 'existing' };
}

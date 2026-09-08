import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/index.js';
import { isContained, type WorkspaceRegistry } from '../workspaces/index.js';
import { MAX_FILE_READ_BYTES } from './tools.js';
import { readDisabledSkillNames, readGlobalDisabledSkillNames } from './store.js';
import type { PlannerWorkspaceRegistry } from './workspaces.js';

/**
 * PA-38: skills for Pocket Agent.
 *
 * A skill is a directory containing a `SKILL.md` — YAML frontmatter naming it
 * (`name`/`description`), then a Markdown body of instructions — that
 * `use_skill` (`planner/tools.ts`) loads verbatim into the conversation. It
 * is inert content, not a capability: loading one only adds text to what the
 * model sees, so there is no approval mechanism of its own here — the model
 * then acts using its own, already-gated tools (`write_file`, `exec_command`,
 * ...). That is what makes this feature safe to build without touching
 * `planner/approval.ts` at all.
 *
 * Modeled on `McpRegistryService`, minus everything that exists there only
 * because a remote MCP server needs a connection, auth, and a cached tool
 * list: there is no network here, and the "row is the truth" is inverted —
 * the *filesystem* is the truth (a global root, plus each planner
 * workspace's own `.skills/` directory), and the two new tables added
 * alongside this module store only enablement *decisions*, the same split
 * PA-6 round 5 already draws for the native tool catalog. `refresh()` is a
 * synchronous disk scan (never throws on a bad entry — a missing or
 * malformed `SKILL.md` is skipped and logged, the same "never crashes on a
 * dead server" posture `McpRegistryService` takes for a connection failure),
 * run once at construction and again on demand from the settings routes.
 */

export class SkillRegistryError extends Error {
  override readonly name = 'SkillRegistryError';
  constructor(
    message: string,
    readonly code: 'not_found' | 'invalid' | 'forbidden',
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/** A slug must be filesystem- and id-safe, and must never contain the `:`
    that separates a skill id's source from its slug (see `mintSkillId`) —
    checked wherever a slug is derived from a directory name or a
    user-supplied name. */
const SLUG_PATTERN = /^[a-z0-9-]+$/;

export function isValidSkillSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/**
 * One skill's catalog entry, as every caller outside this file sees it.
 * Deliberately carries no file path: `SkillRegistryService` re-resolves (and
 * re-validates containment for) the real path on every `loadSkillBody` call
 * rather than handing out something a caller could cache and later use
 * unchecked.
 */
export interface SkillSummary {
  /** `global:<slug>` or `<workspaceId>:<slug>` — see this module's own doc
      comment for why a bare slug is not enough. */
  id: string;
  slug: string;
  name: string;
  description: string;
  /** `'global'`, or the owning planner workspace's id. */
  source: 'global' | string;
  /** What a settings page shows for `source` without looking the workspace
      up itself — `'Global'`, or that agent's current display name. */
  sourceLabel: string;
}

interface LiveSkill {
  summary: SkillSummary;
  /** Absolute, realpath-resolved directory this skill was discovered at —
      internal only; see `SkillSummary`'s own doc comment for why this never
      leaves the service directly. */
  dirPath: string;
}

export interface SkillRegistryServiceOptions {
  db: Db;
  plannerWorkspaces: PlannerWorkspaceRegistry;
  /** The project `WorkspaceRegistry` — needed only so a global skill can be
      registered from (or a skill's body re-validated against) a directory
      inside an added project folder, the same trusted-root list
      `planner/tools.ts`'s file tools already check against. */
  workspaces: WorkspaceRegistry;
  /** Where global skills live — a sibling of `data/planner-workspaces`, not
      a user-picked folder. Created if missing. */
  skillsRoot: string;
  logger: FastifyBaseLogger;
}

/** Where the global skills root lives relative to the database, mirroring
    `plannerWorkspacesRoot`'s own derivation in `app.ts` (a sibling of
    `data/pocketagent.db`'s directory). Exported so `app.ts` and tests agree
    on the same path without duplicating the `path.join` call. */
export function resolvePlannerSkillsRoot(databasePath: string): string {
  return path.join(path.dirname(databasePath), 'planner-skills');
}

/** `<source>:<slug>` — never ambiguous to split, because a slug never
    contains `:` (enforced by `SLUG_PATTERN`) and a source is either the
    literal string `global` or a planner workspace id (a UUID, which also
    never contains `:`). */
function mintSkillId(source: string, slug: string): string {
  return `${source}:${slug}`;
}

function parseSkillId(id: string): { source: string; slug: string } | null {
  const sep = id.indexOf(':');
  if (sep < 0) return null;
  const source = id.slice(0, sep);
  const slug = id.slice(sep + 1);
  if (!source || !slug) return null;
  return { source, slug };
}

/**
 * Hand-rolled frontmatter extractor: the first line must be a bare `---`,
 * the next `---` line closes it, everything between is `key: value` scalar
 * lines (a value may be wrapped in matching quotes), and everything after
 * the closing `---` is the body. No nested structures, no lists — `name`/
 * `description` are the only fields this feature reads, so a full YAML
 * parser (and a new dependency) would buy nothing; see PA-38's posted plan
 * for why this was checked against the existing dependency list first.
 * Returns `null` for anything that doesn't fit that shape, including a file
 * missing `name` or `description` — the caller treats that the same as a
 * missing `SKILL.md` (skip and log, never throw).
 */
export function parseSkillFile(raw: string): { name: string; description: string; body: string } | null {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      endIndex = i;
      break;
    }
  }
  if (endIndex < 0) return null;

  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, endIndex)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }

  const name = fields.name?.trim();
  const description = fields.description?.trim();
  if (!name || !description) return null;

  const body = lines
    .slice(endIndex + 1)
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
  return { name, description, body };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated, ${text.length - max} more characters)`;
}

/** Scans one directory's immediate subdirectories for skills. A directory
    that doesn't exist yet (the common case for a workspace's own `.skills/`,
    which is never pre-created) is treated as "no skills here", not an
    error — the same "unconfigured is a normal steady state" posture
    `web_search`/`url_fetch` already take. */
function scanSkillDir(
  dir: string,
  source: string,
  sourceLabel: string,
  logger: FastifyBaseLogger,
): Map<string, LiveSkill> {
  const out = new Map<string, LiveSkill>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    if (!isValidSkillSlug(slug)) {
      logger.warn(
        { dir, slug },
        `Skipping a skill directory whose name is not a valid slug (must match ${SLUG_PATTERN}).`,
      );
      continue;
    }
    const skillDir = path.join(dir, slug);
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    } catch {
      logger.warn({ skillDir }, 'Skipping a skill directory with no readable SKILL.md.');
      continue;
    }
    const parsed = parseSkillFile(raw);
    if (!parsed) {
      logger.warn(
        { skillDir },
        'Skipping a SKILL.md with missing or malformed frontmatter (name and description are required).',
      );
      continue;
    }
    out.set(slug, {
      summary: {
        id: mintSkillId(source, slug),
        slug,
        name: parsed.name,
        description: parsed.description,
        source,
        sourceLabel,
      },
      dirPath: skillDir,
    });
  }
  return out;
}

export class SkillRegistryService {
  private readonly db: Db;
  private readonly plannerWorkspaces: PlannerWorkspaceRegistry;
  private readonly workspaces: WorkspaceRegistry;
  private readonly skillsRoot: string;
  private readonly logger: FastifyBaseLogger;
  private global = new Map<string, LiveSkill>();
  private byWorkspace = new Map<string, Map<string, LiveSkill>>();

  constructor(opts: SkillRegistryServiceOptions) {
    this.db = opts.db;
    this.plannerWorkspaces = opts.plannerWorkspaces;
    this.workspaces = opts.workspaces;
    this.skillsRoot = opts.skillsRoot;
    this.logger = opts.logger;
    // Created eagerly, like `PlannerWorkspaceRegistry.ensureDefaultWorkspace`
    // creates its own root — `registerGlobalSkill` needs somewhere to write
    // into, and a fresh checkout otherwise has no `planner-skills/` at all.
    fs.mkdirSync(this.skillsRoot, { recursive: true });
    this.refresh();
  }

  /** Re-scans disk synchronously — the global root, plus every planner
      workspace's own `.skills/` directory. Cheap enough to call on every
      mutation (register/delete a global skill) and from an explicit
      "Refresh" button, the same two reasons `McpRegistryService.checkConnection`
      is called from two places one layer down. */
  refresh(): void {
    this.global = scanSkillDir(this.skillsRoot, 'global', 'Global', this.logger);
    const byWorkspace = new Map<string, Map<string, LiveSkill>>();
    for (const ws of this.plannerWorkspaces.list()) {
      byWorkspace.set(ws.id, scanSkillDir(path.join(ws.path, '.skills'), ws.id, ws.name, this.logger));
    }
    this.byWorkspace = byWorkspace;
  }

  /** Every global skill, unfiltered by either deny-list layer — the settings
      page's own catalog (`GET /api/planner/skills`), which shows a global
      skill's *global* enabled state as a checkbox rather than hiding a
      disabled one. */
  listGlobalSkills(): SkillSummary[] {
    return [...this.global.values()].map((s) => s.summary).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Every skill visible to one agent — the global catalog plus that
      agent's own `.skills/` — unfiltered by either deny-list layer. Powers
      the per-agent editor's checklist (`buildAgentSkillsResponse` in
      `routes/planner.ts`), which needs to show a disabled skill (greyed
      out), not omit it. `workspaceId: null` (an orphaned chat) sees only the
      global catalog — the same fallback `PlannerChatService.toolsFor`
      already uses for the native tool catalog. */
  listVisibleTo(workspaceId: string | null): SkillSummary[] {
    const own = workspaceId ? [...(this.byWorkspace.get(workspaceId)?.values() ?? [])] : [];
    return [...this.global.values(), ...own].map((s) => s.summary).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * `listVisibleTo` filtered by both deny-list layers — what `list_skills`/
   * `use_skill` (`planner/tools.ts`) and `PlannerChatService.toolsFor`'s
   * omission check treat as "this agent's currently enabled skills". Mirrors
   * `McpRegistryService.listEnabledTools` exactly, including the global
   * layer applying even for `workspaceId: null`.
   */
  listKnownSkills(workspaceId: string | null): SkillSummary[] {
    const globalDisabled = readGlobalDisabledSkillNames(this.db);
    const agentDisabled = workspaceId ? readDisabledSkillNames(this.db, workspaceId) : new Set<string>();
    if (globalDisabled.size === 0 && agentDisabled.size === 0) return this.listVisibleTo(workspaceId);
    return this.listVisibleTo(workspaceId).filter(
      (s) => !globalDisabled.has(s.id) && !agentDisabled.has(s.id),
    );
  }

  get(id: string): SkillSummary | undefined {
    return this.find(id)?.summary;
  }

  /** Whether a *visible* (but not necessarily enabled) skill is off because
      of the global layer — used by `use_skill`'s refusal wording to tell
      "disabled globally" from "disabled for this agent" the same way
      `PlannerChatService.toolUnavailableMessage` already distinguishes the
      two for a native tool. Callers only reach this after confirming the
      skill exists and is not in `listKnownSkills`'s result. */
  disabledGlobally(id: string): boolean {
    return readGlobalDisabledSkillNames(this.db).has(id);
  }

  private find(id: string): LiveSkill | undefined {
    const parsed = parseSkillId(id);
    if (!parsed) return undefined;
    if (parsed.source === 'global') return this.global.get(parsed.slug);
    return this.byWorkspace.get(parsed.source)?.get(parsed.slug);
  }

  /** True when `real` (already canonicalized) sits inside a root this server
      already trusts for a skill: the global skills root itself, an added
      project workspace, or a planner workspace — the same three-way check
      `planner/tools.ts`'s `isWithinTrustedRoot` applies to a file tool's
      target, plus the skills root, which that helper has no reason to know
      about. */
  private isTrusted(real: string): boolean {
    return (
      isContained(this.skillsRoot, real) ||
      this.workspaces.getRoots().some((root) => isContained(root, real)) ||
      this.plannerWorkspaces.contains(real)
    );
  }

  /**
   * Registers a new *global* skill from an existing directory — validates it
   * contains a parseable `SKILL.md`, then copies it into the skills root
   * under its own slug (derived from the directory name, de-duplicated the
   * same way `PlannerWorkspaceRegistry.create` de-duplicates a workspace's
   * on-disk directory name) so it becomes part of the ordinary scanned
   * catalog — the same reason a skill dropped in place there is discovered
   * with no route at all. A no-op copy (the source already *is* the target
   * directory — an operator who dropped a `SKILL.md` straight into
   * `planner-skills/<slug>/` and is now just registering it) is detected and
   * skipped rather than erroring on "copy onto itself".
   */
  async registerGlobalSkill(requestedPath: string): Promise<SkillSummary> {
    const absolute = path.resolve(requestedPath);
    let real: string;
    try {
      real = await fsp.realpath(absolute);
    } catch {
      throw new SkillRegistryError(`${requestedPath} does not exist.`, 'invalid', 400);
    }
    if (!this.isTrusted(real)) {
      throw new SkillRegistryError(
        `${requestedPath} is outside every project workspace, every planner workspace, and the skills root.`,
        'invalid',
        400,
      );
    }
    const stat = await fsp.stat(real);
    if (!stat.isDirectory()) {
      throw new SkillRegistryError(`${requestedPath} is not a directory.`, 'invalid', 400);
    }
    let raw: string;
    try {
      raw = await fsp.readFile(path.join(real, 'SKILL.md'), 'utf8');
    } catch {
      throw new SkillRegistryError(`${requestedPath} has no readable SKILL.md.`, 'invalid', 400);
    }
    if (!parseSkillFile(raw)) {
      throw new SkillRegistryError(
        `${requestedPath}'s SKILL.md is missing or malformed frontmatter (name and description are required).`,
        'invalid',
        400,
      );
    }

    const baseSlug = slugifyDirName(path.basename(real));
    if (baseSlug.length === 0) {
      throw new SkillRegistryError('Could not derive a slug from this directory name.', 'invalid', 400);
    }
    let slug = baseSlug;
    let suffix = 2;
    while (this.global.has(slug) && path.join(this.skillsRoot, slug) !== real) {
      slug = `${baseSlug}-${suffix++}`;
    }
    const target = path.join(this.skillsRoot, slug);
    if (target !== real) {
      await fsp.cp(real, target, { recursive: true });
    }

    this.refresh();
    const summary = this.get(mintSkillId('global', slug));
    if (!summary) {
      throw new SkillRegistryError('Registered the skill, but it could not be re-read.', 'invalid', 500);
    }
    this.logger.info({ skill: summary.id }, 'Global skill registered');
    return summary;
  }

  /**
   * Forget a global skill: refuses a per-workspace one (its directory lives
   * inside that agent's own scratch space and is deleted the same way any
   * other file there is — `rmdir`/the tool, not this route) and, for a real
   * global one, removes its directory and every enablement row that names
   * it — a disabled-skill row is pure current configuration of a skill that,
   * once gone, makes the row meaningless, the same cleanup
   * `McpRegistryService.remove` performs for a deleted registry's tools.
   */
  async removeGlobalSkill(id: string): Promise<void> {
    const live = this.find(id);
    if (!live) throw new SkillRegistryError(`No such skill: ${id}`, 'not_found', 404);
    if (live.summary.source !== 'global') {
      throw new SkillRegistryError(
        `"${live.summary.name}" belongs to an agent, not the global catalog — delete it as a file within that agent's workspace instead.`,
        'forbidden',
        403,
      );
    }
    await fsp.rm(live.dirPath, { recursive: true, force: true });
    this.db.prepare('DELETE FROM planner_global_disabled_skills WHERE skill_id = ?').run(id);
    this.db.prepare('DELETE FROM planner_agent_disabled_skills WHERE skill_id = ?').run(id);
    this.refresh();
    this.logger.info({ skill: id }, 'Global skill deleted');
  }

  /**
   * Resolves a skill id back to its `SKILL.md`, re-validating containment
   * against the live path rather than trusting the cached `dirPath` blindly
   * — the same "re-validate at call time" discipline `send_instruction`
   * already applies before resuming a session by its cached `cwd`. Returns
   * the body only (frontmatter stripped), truncated at the same
   * `MAX_FILE_READ_BYTES` limit `read_file` applies to any other file this
   * server reads on a model's behalf.
   */
  async loadSkillBody(id: string): Promise<string> {
    const live = this.find(id);
    if (!live) throw new SkillRegistryError(`No such skill: ${id}`, 'not_found', 404);
    let real: string;
    try {
      real = await fsp.realpath(live.dirPath);
    } catch {
      throw new SkillRegistryError(`"${live.summary.name}"'s directory no longer exists.`, 'not_found', 404);
    }
    if (!this.isTrusted(real)) {
      throw new SkillRegistryError(`"${live.summary.name}"'s directory is no longer inside a trusted root.`, 'forbidden', 403);
    }
    let raw: string;
    try {
      raw = await fsp.readFile(path.join(real, 'SKILL.md'), 'utf8');
    } catch {
      throw new SkillRegistryError(`"${live.summary.name}"'s SKILL.md could not be read.`, 'not_found', 404);
    }
    const parsed = parseSkillFile(raw);
    if (!parsed) {
      throw new SkillRegistryError(`"${live.summary.name}"'s SKILL.md is no longer valid.`, 'invalid', 500);
    }
    return truncate(parsed.body, MAX_FILE_READ_BYTES);
  }
}

function slugifyDirName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { SKILL_PROJECT_DIRS, type SkillExportTarget } from '@pocketagent/protocol';
import { readSetting, writeSetting, type Db } from '../db/index.js';
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
    readonly code: 'not_found' | 'invalid' | 'forbidden' | 'skill_exists',
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

/**
 * PA-38 round 2: one skill found under a *project* workspace's own
 * `.claude/skills/` or `.agents/skills/` — the coding-agent conventions
 * (Claude Code, and the newer cross-tool `.agents/` layout Codex and others
 * use) — but not yet copied into the Pocket Agent catalog. Unlike
 * `SkillSummary`, `path` is the real absolute directory, deliberately: this
 * shape only ever feeds `POST /api/planner/skills` (which re-validates
 * containment itself), never a cached handle used unchecked later, so there
 * is no invariant here to protect by hiding it. Discovery is stateless and
 * computed fresh on every call — see `discoverImportableSkills`'s own doc
 * comment for why nothing here is merged into the visible catalog
 * automatically.
 */
export interface DiscoveredSkill {
  path: string;
  name: string;
  description: string;
  source: 'claude' | 'agents';
  /** Whatever readable label the owning project workspace has — see
      `discoverImportableSkills`'s own doc comment. */
  projectLabel: string;
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

/** Where the global skills root lives inside the data root, mirroring
    `plannerWorkspacesRoot`'s own derivation in `app.ts` (both are siblings of
    `pocketagent.db`). Exported so `app.ts` and tests agree on the same path
    without duplicating the `path.join` call. Takes `config.dataDir` rather
    than the database path it used to take the dirname of — see that field's
    own doc comment for why the root is named directly (PA-62). */
export function resolvePlannerSkillsRoot(dataDir: string): string {
  return path.join(dataDir, 'planner-skills');
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

    const summary = await this.copyIntoGlobalCatalog(real, path.basename(real));
    this.logger.info({ skill: summary.id }, 'Global skill registered');
    return summary;
  }

  /**
   * Shared by `registerGlobalSkill` and `promoteToGlobal`: copy `sourceDir`
   * into the skills root under a slug derived from `slugBasis`, de-duplicated
   * the same way `PlannerWorkspaceRegistry.create` de-duplicates a
   * workspace's on-disk directory name — `-2`, `-3`, ... until one is free.
   * A no-op copy (the source already *is* the target directory — an operator
   * who dropped a `SKILL.md` straight into `planner-skills/<slug>/` and is
   * now just registering it) is detected and skipped rather than erroring on
   * "copy onto itself".
   */
  private async copyIntoGlobalCatalog(sourceDir: string, slugBasis: string): Promise<SkillSummary> {
    const baseSlug = slugifyDirName(slugBasis);
    if (baseSlug.length === 0) {
      throw new SkillRegistryError('Could not derive a slug from this directory name.', 'invalid', 400);
    }
    let slug = baseSlug;
    let suffix = 2;
    while (this.global.has(slug) && path.join(this.skillsRoot, slug) !== sourceDir) {
      slug = `${baseSlug}-${suffix++}`;
    }
    const target = path.join(this.skillsRoot, slug);
    if (target !== sourceDir) {
      await fsp.cp(sourceDir, target, { recursive: true });
    }

    this.refresh();
    const summary = this.get(mintSkillId('global', slug));
    if (!summary) {
      throw new SkillRegistryError('Copied the skill, but it could not be re-read.', 'invalid', 500);
    }
    return summary;
  }

  /**
   * PA-38 round 2: "a way from UI to 'promote' any skills to global in case
   * needed, that's user manual operation." Takes an id, not a path — same
   * reason `SkillSummary` never carries one — so the frontend never round-
   * trips a filesystem path for this action; it only ever passes back an id
   * it already displayed. Refuses a skill that is already global (copying it
   * onto itself would be a confusing no-op, not a promotion) rather than
   * silently succeeding.
   */
  async promoteToGlobal(id: string): Promise<SkillSummary> {
    const live = this.find(id);
    if (!live) throw new SkillRegistryError(`No such skill: ${id}`, 'not_found', 404);
    if (live.summary.source === 'global') {
      throw new SkillRegistryError(`"${live.summary.name}" is already global.`, 'invalid', 400);
    }
    let real: string;
    try {
      real = await fsp.realpath(live.dirPath);
    } catch {
      throw new SkillRegistryError(`"${live.summary.name}"'s directory no longer exists.`, 'not_found', 404);
    }
    const summary = await this.copyIntoGlobalCatalog(real, live.summary.slug);
    this.logger.info({ skill: id, promotedTo: summary.id }, 'Skill promoted to global');
    return summary;
  }

  /**
   * PA-38 round 2: author a new skill directly in the *calling* agent's own
   * workspace (`<workspace>/.skills/<slug>/SKILL.md`) — the `write_skill`
   * tool's implementation. Deliberately narrower than `registerGlobalSkill`:
   * it never reaches the global catalog (promotion there is the separate,
   * explicit, manual UI action above) and it never auto-suffixes a slug to
   * dodge a collision — a repeated call with the same name refuses outright
   * unless `overwrite` is set, so the model's own retries can't silently pile
   * up `foo`, `foo-2`, `foo-3`, ....
   */
  async writeWorkspaceSkill(
    workspaceId: string,
    opts: { name: string; description: string; body: string; overwrite?: boolean },
  ): Promise<SkillSummary> {
    const ws = this.plannerWorkspaces.get(workspaceId);
    if (!ws) throw new SkillRegistryError('This agent workspace no longer exists.', 'not_found', 404);
    const name = opts.name.trim();
    const description = opts.description.trim();
    const body = opts.body.trim();
    if (!name) throw new SkillRegistryError('A skill needs a name.', 'invalid', 400);
    if (!description) throw new SkillRegistryError('A skill needs a description.', 'invalid', 400);
    if (!body) throw new SkillRegistryError('A skill needs a body.', 'invalid', 400);

    const slug = slugifyDirName(name);
    if (slug.length === 0) {
      throw new SkillRegistryError('Could not derive a slug from this name.', 'invalid', 400);
    }
    const dir = path.join(ws.path, '.skills', slug);
    const existing = await fsp.stat(dir).catch(() => null);
    if (existing && !opts.overwrite) {
      throw new SkillRegistryError(
        `A skill named "${slug}" already exists in this agent's workspace. Pass overwrite: true to replace it.`,
        'invalid',
        409,
      );
    }

    await fsp.mkdir(dir, { recursive: true });
    const frontmatter = `---\nname: ${yamlScalar(name)}\ndescription: ${yamlScalar(description)}\n---\n`;
    await fsp.writeFile(path.join(dir, 'SKILL.md'), `${frontmatter}${body}\n`, 'utf8');

    this.refresh();
    const summary = this.get(mintSkillId(workspaceId, slug));
    if (!summary) {
      throw new SkillRegistryError('Wrote the skill, but it could not be re-read.', 'invalid', 500);
    }
    this.logger.info({ skill: summary.id }, 'Workspace skill written');
    return summary;
  }

  /**
   * PA-70: register a *global* skill from its content, under a caller-supplied
   * slug — `POST /api/planner/skills/import`, which exists so a Hub can
   * provision a skill onto a host whose filesystem it knows nothing about.
   *
   * Three deliberate differences from its two neighbours here.
   * `registerGlobalSkill` takes a path on this machine, which a remote caller
   * cannot supply; this takes bytes. `writeWorkspaceSkill` derives the slug
   * from the name and lands in one agent's `.skills/`; this takes the slug
   * verbatim and lands in the global catalog, because the caller's own ledger
   * keys on `global:<slug>` and a slug re-derived here could differ from the
   * one it recorded. And `copyIntoGlobalCatalog` auto-suffixes a colliding
   * slug (`-2`, `-3`, ...) to make a human's import succeed; this refuses
   * outright unless `overwrite` is set, because a provisioning run that
   * quietly created `release-notes-2` on one host and `release-notes` on
   * another would leave a fleet that looks uniform and is not.
   *
   * The slug is re-validated here rather than trusted from the route's schema:
   * it becomes a directory name, so this is the containment check, and it must
   * hold for every caller including the one that arrives next year.
   */
  async importGlobalSkill(opts: {
    slug: string;
    name: string;
    description: string;
    body: string;
    overwrite?: boolean;
  }): Promise<SkillSummary> {
    const slug = opts.slug.trim();
    if (!isValidSkillSlug(slug)) {
      throw new SkillRegistryError(
        'A skill slug is lowercase letters, digits and hyphens.',
        'invalid',
        400,
      );
    }
    const name = opts.name.trim();
    const description = opts.description.trim();
    const body = opts.body.trim();
    if (!name) throw new SkillRegistryError('A skill needs a name.', 'invalid', 400);
    if (!description) throw new SkillRegistryError('A skill needs a description.', 'invalid', 400);
    if (!body) throw new SkillRegistryError('A skill needs a body.', 'invalid', 400);

    const dir = path.join(this.skillsRoot, slug);
    const existing = await fsp.stat(dir).catch(() => null);
    if (existing && opts.overwrite !== true) {
      throw new SkillRegistryError(
        `A global skill named "${slug}" already exists. Confirm an overwrite to replace it.`,
        'invalid',
        409,
      );
    }

    await fsp.mkdir(dir, { recursive: true });
    const frontmatter = `---\nname: ${yamlScalar(name)}\ndescription: ${yamlScalar(description)}\n---\n`;
    await fsp.writeFile(path.join(dir, 'SKILL.md'), `${frontmatter}${body}\n`, 'utf8');

    this.refresh();
    const summary = this.get(mintSkillId('global', slug));
    if (!summary) {
      throw new SkillRegistryError('Wrote the skill, but it could not be re-read.', 'invalid', 500);
    }
    this.logger.info(
      { skill: summary.id, overwrote: existing !== null },
      'Global skill imported from content',
    );
    return summary;
  }

  /**
   * PA-38 round 2: "You can have a UI, globally scan and user can choose to
   * import" — scans every *project* workspace's own `.claude/skills/`
   * (Claude Code's convention) and `.agents/skills/` (the newer cross-tool
   * convention Codex and others use) for a valid `SKILL.md`, using the exact
   * same `scanSkillDir` this service already scans the global root and every
   * planner workspace's `.skills/` with. Deliberately **not** folded into
   * `listVisibleTo`/`listKnownSkills` — the reporter's own "user can choose
   * to import" means visibility here is opt-in, so a coding agent's skill
   * never silently becomes available to a Pocket Agent chat. Stateless: a
   * fresh scan on every call, never cached beyond the single call, so a
   * skill added to a project between two calls is picked up on the next one
   * with no `refresh()` needed (nothing here mutates `this.global`/
   * `this.byWorkspace`).
   */
  discoverImportableSkills(): DiscoveredSkill[] {
    const out: DiscoveredSkill[] = [];
    // PA-55: the same table `exportToProject` writes into, so the two
    // directions cannot drift on where a coding agent keeps its skills.
    const sources = Object.entries(SKILL_PROJECT_DIRS) as [SkillExportTarget, string][];
    for (const root of this.workspaces.getRoots()) {
      const projectLabel = path.basename(root) || root;
      for (const [source, relDir] of sources) {
        const scanned = scanSkillDir(path.join(root, ...relDir.split('/')), source, projectLabel, this.logger);
        for (const live of scanned.values()) {
          out.push({
            path: live.dirPath,
            name: live.summary.name,
            description: live.summary.description,
            source,
            projectLabel,
          });
        }
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  }

  /**
   * PA-55: copy one catalog skill into a project tree's coding-agent skill
   * directory (`SKILL_PROJECT_DIRS`), so a `claude`/`codex` session working
   * there can load it. This is the reverse of `discoverImportableSkills`.
   *
   * Reached only from a human-driven route. No planner tool and no MCP tool
   * calls it, which is why the approval gate needs no new rule. A model that
   * wants a skill in a project still has to use `write_file`, gated as ever.
   * What it *does* add is the first structured path from a Pocket Agent's
   * scratch space into a directory a coding agent treats as source, so every
   * rule below is about keeping that path from writing anything else:
   *
   * - The source is an id, re-resolved and re-checked against the trusted
   *   roots, exactly as `loadSkillBody` does.
   * - The destination is re-resolved through `WorkspaceRegistry`
   *   (realpath, then containment), and must not be a planner workspace or
   *   the skills root. A planner workspace is scratch space, not a project.
   * - The skill directory (`.claude/skills`) is realpath'd after it exists
   *   and must still be inside the project. Otherwise a `.claude` symlink
   *   pointing out of the repository redirects the write, which the
   *   containment check on `projectPath` alone cannot see.
   * - Only regular files and directories are copied, each file opened with
   *   `O_NOFOLLOW`. A symlink in a skill's folder is refused, never
   *   followed: one pointing at `~/.ssh` would otherwise put a key into a
   *   repository. Size and count are capped.
   * - Every target is checked before anything is written. A collision is a
   *   409 with nothing written unless `overwrite` is set. With it, the copy
   *   is built in a sibling temp directory and swapped in by `rename`, so a
   *   failure never leaves a half-written skill where an agent will load it.
   *
   * Nothing here touches git. The files are untracked changes, and
   * committing them is the user's decision.
   */
  async exportToProject(opts: {
    skillId: string;
    projectPath: string;
    targets: readonly SkillExportTarget[];
    overwrite?: boolean;
  }): Promise<{ projectRoot: string; results: { target: SkillExportTarget; path: string; overwrote: boolean }[] }> {
    const live = this.find(opts.skillId);
    if (!live) throw new SkillRegistryError(`No such skill: ${opts.skillId}`, 'not_found', 404);
    const { slug, name } = live.summary;
    let sourceReal: string;
    try {
      sourceReal = await fsp.realpath(live.dirPath);
    } catch {
      throw new SkillRegistryError(`"${name}"'s directory no longer exists.`, 'not_found', 404);
    }
    if (!this.isTrusted(sourceReal)) {
      throw new SkillRegistryError(`"${name}"'s directory is no longer inside a trusted root.`, 'forbidden', 403);
    }
    const entries = await collectExportEntries(sourceReal, name);
    if (!entries.some((e) => e.kind === 'file' && e.rel === 'SKILL.md')) {
      throw new SkillRegistryError(`"${name}" has no SKILL.md.`, 'invalid', 400);
    }
    const skillMd = await readNoFollow(path.join(sourceReal, 'SKILL.md'));
    if (!parseSkillFile(skillMd.toString('utf8'))) {
      throw new SkillRegistryError(
        `"${name}"'s SKILL.md is missing or malformed frontmatter, so a coding agent could not load it.`,
        'invalid',
        400,
      );
    }

    // Throws `WorkspaceError` for anything outside every project folder. The
    // route maps it the same way every other directory-taking route does.
    const projectRoot = await this.workspaces.resolveWorkspacePath(opts.projectPath);
    if (this.plannerWorkspaces.contains(projectRoot) || isContained(this.skillsRoot, projectRoot)) {
      throw new SkillRegistryError(
        "That directory is a Pocket Agent's own workspace, not a project. Export into a project folder.",
        'forbidden',
        403,
      );
    }

    const targets = [...new Set(opts.targets)];
    if (targets.length === 0) {
      throw new SkillRegistryError('Pick at least one skill directory to export into.', 'invalid', 400);
    }

    // Phase 1: check every target, write nothing.
    const plans: { target: SkillExportTarget; parent: string; dest: string; exists: boolean }[] = [];
    for (const target of targets) {
      const parent = path.join(projectRoot, ...SKILL_PROJECT_DIRS[target].split('/'));
      await this.assertInsideProject(projectRoot, parent);
      const dest = path.join(parent, slug);
      const existing = await fsp.lstat(dest).catch(() => null);
      if (existing?.isSymbolicLink()) {
        throw new SkillRegistryError(
          `${dest} is a symbolic link. Refusing to write through it; remove it first.`,
          'forbidden',
          403,
        );
      }
      if (existing && opts.overwrite !== true) {
        throw new SkillRegistryError(
          `A skill named "${slug}" already exists at ${dest}. Confirm an overwrite to replace it.`,
          'skill_exists',
          409,
        );
      }
      plans.push({ target, parent, dest, exists: existing !== null });
    }

    // Phase 2: write each target through a temp directory.
    const results: { target: SkillExportTarget; path: string; overwrote: boolean }[] = [];
    for (const plan of plans) {
      await fsp.mkdir(plan.parent, { recursive: true });
      // Re-checked now that the directory exists. A `.claude` that was absent
      // in phase 1 cannot have been a symlink, but one created in between is
      // exactly the race this second look closes.
      const parentReal = await this.assertInsideProject(projectRoot, plan.parent);
      const dest = path.join(parentReal, slug);
      const tag = randomBytes(4).toString('hex');
      const staging = path.join(parentReal, `.${slug}.pa-export-${tag}`);
      const retired = path.join(parentReal, `.${slug}.pa-replaced-${tag}`);
      try {
        await fsp.mkdir(staging);
        for (const entry of entries) {
          const out = path.join(staging, entry.rel);
          if (entry.kind === 'dir') {
            await fsp.mkdir(out, { recursive: true });
          } else {
            const bytes = await readNoFollow(path.join(sourceReal, entry.rel));
            await fsp.writeFile(out, bytes, { flag: 'wx' });
          }
        }
        const existing = await fsp.lstat(dest).catch(() => null);
        if (existing?.isSymbolicLink()) {
          throw new SkillRegistryError(`${dest} became a symbolic link during the export.`, 'forbidden', 403);
        }
        if (existing) await fsp.rename(dest, retired);
        await fsp.rename(staging, dest);
        if (existing) await fsp.rm(retired, { recursive: true, force: true });
        results.push({ target: plan.target, path: dest, overwrote: existing !== null });
      } catch (err) {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
        throw err;
      }
    }

    this.logger.info(
      { skill: live.summary.id, projectRoot, targets, overwrote: results.some((r) => r.overwrote) },
      'Skill exported into a project tree',
    );
    return { projectRoot, results };
  }

  /** Realpath of `dir`'s deepest existing ancestor (or `dir` itself) must be
      inside `projectRoot`. Returns `dir`'s realpath when it exists, else the
      lexical path. A symlinked `.claude` that leaves the project fails here. */
  private async assertInsideProject(projectRoot: string, dir: string): Promise<string> {
    let probe = dir;
    let suffix: string[] = [];
    for (;;) {
      try {
        const real = await fsp.realpath(probe);
        if (!isContained(projectRoot, real)) {
          throw new SkillRegistryError(
            `${dir} resolves outside the project (${real}). Refusing to export through a link that leaves it.`,
            'forbidden',
            403,
          );
        }
        return suffix.length === 0 ? real : path.join(real, ...suffix);
      } catch (err) {
        if (err instanceof SkillRegistryError) throw err;
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' || probe === projectRoot) throw err;
        suffix = [path.basename(probe), ...suffix];
        probe = path.dirname(probe);
      }
    }
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

/** PA-55: what one export may carry. A skill is instructions plus a few
    reference files. Anything near these limits is not a skill, and copying it
    into a repository on one click would be a surprise. */
export const MAX_SKILL_EXPORT_BYTES = 1024 * 1024;
export const MAX_SKILL_EXPORT_FILES = 200;

interface ExportEntry {
  rel: string;
  kind: 'file' | 'dir';
}

/** Walks a skill directory with `lstat`, so nothing is followed. Returns
    directories before their contents, so creating them in order works. */
async function collectExportEntries(root: string, skillName: string): Promise<ExportEntry[]> {
  const out: ExportEntry[] = [];
  let files = 0;
  let bytes = 0;
  const walk = async (relDir: string): Promise<void> => {
    const dirents = await fsp.readdir(path.join(root, relDir), { withFileTypes: true });
    for (const d of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relDir ? path.join(relDir, d.name) : d.name;
      const st = await fsp.lstat(path.join(root, rel));
      if (st.isSymbolicLink()) {
        throw new SkillRegistryError(
          `"${skillName}" contains a symbolic link (${rel}). Links are never exported; replace it with the file itself.`,
          'invalid',
          400,
        );
      }
      if (st.isDirectory()) {
        out.push({ rel, kind: 'dir' });
        await walk(rel);
      } else if (st.isFile()) {
        files += 1;
        bytes += st.size;
        if (files > MAX_SKILL_EXPORT_FILES) {
          throw new SkillRegistryError(
            `"${skillName}" has more than ${MAX_SKILL_EXPORT_FILES} files, which is more than a skill export carries.`,
            'invalid',
            400,
          );
        }
        if (bytes > MAX_SKILL_EXPORT_BYTES) {
          throw new SkillRegistryError(
            `"${skillName}" is larger than ${MAX_SKILL_EXPORT_BYTES / 1024 / 1024} MiB, which is more than a skill export carries.`,
            'invalid',
            400,
          );
        }
        out.push({ rel, kind: 'file' });
      } else {
        throw new SkillRegistryError(
          `"${skillName}" contains ${rel}, which is not a regular file or directory.`,
          'invalid',
          400,
        );
      }
    }
  };
  await walk('');
  return out;
}

/** Reads a file without following a symlink at the last component, so a file
    swapped for a link after `collectExportEntries` looked at it is refused
    rather than read. The size is checked again against what was actually read. */
async function readNoFollow(file: string): Promise<Buffer> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new SkillRegistryError(`${path.basename(file)} became a symbolic link during the export.`, 'invalid', 400);
    }
    throw err;
  }
  try {
    const bytes = await handle.readFile();
    if (bytes.length > MAX_SKILL_EXPORT_BYTES) {
      throw new SkillRegistryError(`${path.basename(file)} grew past the export size limit.`, 'invalid', 400);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function slugifyDirName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Quotes a frontmatter scalar when writing one out (`writeWorkspaceSkill`),
 * so it round-trips cleanly through `parseSkillFile`'s own naive strip-one-
 * matching-pair-of-quotes logic. A colon inside an unquoted value is
 * actually harmless to *this* parser (the whole rest of the line is
 * captured as the value regardless), but a value that itself starts and
 * ends with a quote character is not — reading it back would strip real
 * content mistaking it for wrapping. Quoting proactively for either case
 * avoids relying on that parser detail staying true. Prefers double quotes;
 * falls back to single if the value itself contains a `"`, and to double
 * again (imperfect, but only reachable when a value contains both quote
 * characters) if it contains both — `parseSkillFile` only ever strips the
 * single outermost pair we add here, so any consistent wrapping round-trips
 * the original value byte-for-byte no matter what it contains.
 */
function yamlScalar(value: string): string {
  const needsQuoting =
    value.includes(':') || value.startsWith('"') || value.startsWith("'") || value.endsWith('"') || value.endsWith("'");
  if (!needsQuoting) return value;
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value}"`;
}

/** Settings flag guarding the bundled `skill-creator` meta-skill's seed —
    the exact one-shot pattern `workspaces_seeded`/
    `legacy_claude_providers_migrated` already use elsewhere (see
    `CLAUDE.md`'s own description of that discipline): flag-gated rather than
    "the directory is empty", so deleting the seeded skill through the
    ordinary delete route does not resurrect it on the next boot. */
const PLANNER_DEFAULT_SKILLS_SEEDED_KEY = 'planner_default_skills_seeded';

/**
 * PA-38 round 2: a bundled meta-skill seeded once into the global catalog —
 * guidance for the model on writing a *good* skill, modeled loosely on
 * Anthropic's own public `skill-creator` example skill's purpose (not its
 * full test-harness machinery — this is guidance content, kept short).
 */
const SKILL_CREATOR_CONTENT = `---
name: skill-creator
description: Use when asked to create, write, or generate a new skill for this agent (or another one) — explains how to write one that will actually get used, not just one that technically exists.
---

# Writing a skill that gets used

A skill is only useful if two things happen: the model reaches for it at the
right moment, and it can act on it once loaded. Most skills that go unused
fail at the first part, not the second.

## The description is the trigger, not a summary

\`list_skills\` shows every enabled skill's name and description, and that is
the *only* signal deciding whether a skill gets loaded with \`use_skill\`.
"Formats a report" describes what a skill does; "Use when asked to turn raw
notes into a shareable status report" describes *when* to reach for it.
Write the second kind. State the trigger — the phrasing, task, or situation
that should make this skill come to mind — before (or instead of) describing
the mechanism.

## Keep the body focused

The body is what actually lands in the conversation once loaded. A skimmable,
few-hundred-word set of steps beats an exhaustive manual: the model has
already decided to use the skill by the time it reads the body, so the job
left is "tell me exactly what to do," not "teach me the whole subject."

## Split long reference material out

If a skill genuinely needs a large reference — a full API spec, a long list
of edge cases, a style guide — do not inline it into \`SKILL.md\`. Write it to
a separate file alongside \`SKILL.md\` (in the same skill directory, via
\`write_file\`) and have the body point to it by name. That keeps the skill
itself skimmable and lets the model open the reference only when the task at
hand actually needs that depth.

## Worked example

Bad description: "Generates changelogs." Better: "Use when asked to write a
changelog entry from a list of commits or PR titles — turns raw commit
messages into user-facing release notes." The second version fires when
someone actually asks for a changelog; the first only fires if the model
happens to already be thinking about changelogs.

## Saving what you draft

Once you have drafted a skill's name, description, and body, save it with
the \`write_skill\` tool — it writes straight to this agent's own
\`.skills/\` directory as a proper \`SKILL.md\`. From there, an operator can
promote it to the global catalog from Settings if every agent should have
it, not just this one.
`;

/**
 * Seeds the bundled `skill-creator` meta-skill into the global catalog, the
 * first time only — mirrors `PlannerWorkspaceRegistry.ensureDefaultWorkspace`
 * exactly: the flag is checked *before* anything is written, so a crash or a
 * concurrent second call can never write the skill twice, and deleting it
 * afterward through the ordinary `DELETE /api/planner/skills/:id` route does
 * not bring it back on the next boot. Called from `app.ts` right after
 * `SkillRegistryService` is constructed (so `skillsRoot` is guaranteed to
 * exist already).
 */
export async function seedDefaultSkills(opts: {
  skills: SkillRegistryService;
  skillsRoot: string;
  db: Db;
  logger: FastifyBaseLogger;
}): Promise<void> {
  const { skills, skillsRoot, db, logger } = opts;
  if (readSetting(db, PLANNER_DEFAULT_SKILLS_SEEDED_KEY) !== null) return;
  const dir = path.join(skillsRoot, 'skill-creator');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'SKILL.md'), SKILL_CREATOR_CONTENT, 'utf8');
  skills.refresh();
  writeSetting(db, PLANNER_DEFAULT_SKILLS_SEEDED_KEY, new Date().toISOString());
  logger.info('Seeded the bundled skill-creator meta-skill into the global catalog.');
}

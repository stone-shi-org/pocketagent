import crypto from 'node:crypto';
import {
  parseTemplatePayload,
  secretHolesFor,
  type HubTemplate,
  type HubTemplateKind,
  type HubTemplatePayload,
  type ProvisioningOutcome,
} from '@pocketagent/protocol';
import type { HubDb, HubProvisioningRow, HubTemplateRow } from '../db.js';

/**
 * PA-134: ids of the templates the Fleet agent provisions through. They are
 * ordinary rows — so a coordinator's Pocket Agent and MCP registry land in
 * `hub_provisionings` like any other provisioning, and the backend audits each
 * call as it would any template — but they are managed by the fleet service:
 * hidden from the template list and refused by the edit, delete and
 * instantiate routes, since the registry's bearer is a token only the fleet
 * flow ever holds.
 */
export const SYSTEM_TEMPLATE_PREFIX = 'system-';

export function isSystemTemplateId(id: string): boolean {
  return id.startsWith(SYSTEM_TEMPLATE_PREFIX);
}

/** A row whose payload has been validated back into its kind's shape. */
export interface ResolvedTemplate {
  readonly row: HubTemplateRow;
  readonly spec: HubTemplatePayload;
}

/**
 * PA-70: `hub_templates` and `hub_provisionings`.
 *
 * Two things here are deliberate rather than incidental.
 *
 * **A payload is re-validated on the way out, not only on the way in.**
 * `get`/`list` return `null`/skip a row whose `payload_json` no longer parses
 * against its kind, so a hand-edited database (or a row written by a build
 * whose schema has since changed) cannot reach the provisioner — which is the
 * one place in this service that makes an authenticated write to somebody
 * else's machine. The alternative, trusting the column because we wrote it, is
 * the kind of assumption that holds right up until a migration.
 *
 * **Editing bumps `revision` and touches no host.** There is no
 * reconciliation anywhere in this class, by design: the ledger keeps whichever
 * revision each host actually received, and `stale` is computed for display.
 * Anything that silently re-pushed on edit would be the drift-correcting loop
 * the ticket explicitly rules out, and it would fight the per-host editors
 * that already exist for every one of these resources.
 */
export class TemplateStore {
  constructor(private readonly db: HubDb) {}

  create(input: {
    kind: HubTemplateKind;
    name: string;
    description: string;
    spec: HubTemplatePayload;
    now?: number;
  }): HubTemplateRow {
    const now = input.now ?? Date.now();
    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO hub_templates (id, kind, name, description, revision, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(id, input.kind, input.name, input.description, JSON.stringify(input.spec.payload), now, now);
    return this.rowFor(id)!;
  }

  /**
   * PA-134: write a system template's current payload, creating it the first
   * time. The revision bumps only when the payload actually changed, so the
   * ledger's "dev01 has r3" stays meaningful for these too.
   */
  upsertSystem(input: { id: string; name: string; description: string; spec: HubTemplatePayload }, now = Date.now()): ResolvedTemplate {
    if (!isSystemTemplateId(input.id)) throw new Error(`${input.id} is not a system template id.`);
    const payload = JSON.stringify(input.spec.payload);
    const existing = this.rowFor(input.id);
    if (existing === null) {
      this.db
        .prepare(
          `INSERT INTO hub_templates (id, kind, name, description, revision, payload_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(input.id, input.spec.kind, input.name, input.description, payload, now, now);
    } else if (existing.payload_json !== payload || existing.name !== input.name) {
      this.db
        .prepare(
          `UPDATE hub_templates SET name = ?, description = ?, payload_json = ?, revision = revision + 1, updated_at = ?
            WHERE id = ?`,
        )
        .run(input.name, input.description, payload, now, input.id);
    }
    const resolved = this.resolve(input.id);
    if (resolved === null) throw new Error(`System template ${input.id} did not read back.`);
    return resolved;
  }

  rowFor(id: string): HubTemplateRow | null {
    return (
      (this.db.prepare('SELECT * FROM hub_templates WHERE id = ?').get(id) as
        | HubTemplateRow
        | undefined) ?? null
    );
  }

  /**
   * A row plus its parsed payload, or null for a missing *or unparseable* row.
   *
   * Collapsing those two cases is intentional: the route answers 404 either
   * way, because a template whose payload cannot be read is not a template
   * anyone can act on, and there is no partial operation worth offering on it.
   * The parse failure is logged by the caller that has a logger.
   */
  resolve(id: string): ResolvedTemplate | null {
    const row = this.rowFor(id);
    if (row === null) return null;
    const parsed = parseTemplatePayload(row.kind as HubTemplateKind, safeJson(row.payload_json));
    if (!parsed.ok) return null;
    return { row, spec: parsed.value };
  }

  update(
    id: string,
    patch: { name?: string; description?: string; spec?: HubTemplatePayload },
    now = Date.now(),
  ): HubTemplateRow | null {
    const row = this.rowFor(id);
    if (row === null) return null;
    // The revision bump is unconditional on any edit, including a rename. It
    // is a "this template is not what dev01 received" marker rather than a
    // content hash: an operator who renamed a template and wants the host to
    // match can re-provision, and a marker that tried to be clever about which
    // fields "really" changed would eventually be wrong about one.
    this.db
      .prepare(
        `UPDATE hub_templates
            SET name = COALESCE(?, name),
                description = COALESCE(?, description),
                payload_json = COALESCE(?, payload_json),
                revision = revision + 1,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(
        patch.name ?? null,
        patch.description ?? null,
        patch.spec ? JSON.stringify(patch.spec.payload) : null,
        now,
        id,
      );
    return this.rowFor(id);
  }

  remove(id: string): boolean {
    // `hub_provisionings` CASCADEs, so the ledger goes with it. What stays is
    // whatever was actually written on each backend — deleting a template has
    // never meant un-provisioning anything, and the UI says so.
    return this.db.prepare('DELETE FROM hub_templates WHERE id = ?').run(id).changes > 0;
  }

  provisioningsFor(templateId: string): HubProvisioningRow[] {
    return this.db
      .prepare('SELECT * FROM hub_provisionings WHERE template_id = ? ORDER BY provisioned_at')
      .all(templateId) as HubProvisioningRow[];
  }

  provisioningFor(templateId: string, hostId: string): HubProvisioningRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM hub_provisionings WHERE template_id = ? AND host_id = ?')
        .get(templateId, hostId) as HubProvisioningRow | undefined) ?? null
    );
  }

  /**
   * Record the outcome of one host's run.
   *
   * Every terminal outcome is recorded, not just the successful ones, so the
   * UI can show "this failed here, and why" without a second table — and so a
   * retry knows there was a previous attempt. A row whose `last_result` is a
   * failure still carries whatever `remote_id` a previous success recorded:
   * losing that would strand the resource, leaving the Hub unable to overwrite
   * something it demonstrably created.
   */
  recordProvisioning(input: {
    templateId: string;
    hostId: string;
    remoteId: string | null;
    revision: number;
    outcome: ProvisioningOutcome;
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO hub_provisionings
           (template_id, host_id, remote_id, template_revision, provisioned_at, last_result)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (template_id, host_id) DO UPDATE SET
           remote_id = COALESCE(excluded.remote_id, hub_provisionings.remote_id),
           template_revision = excluded.template_revision,
           provisioned_at = excluded.provisioned_at,
           last_result = excluded.last_result`,
      )
      .run(input.templateId, input.hostId, input.remoteId, input.revision, now, input.outcome);
  }

  /** Drop a ledger row — used when a host no longer has what it claims. */
  forgetProvisioning(templateId: string, hostId: string): void {
    this.db
      .prepare('DELETE FROM hub_provisionings WHERE template_id = ? AND host_id = ?')
      .run(templateId, hostId);
  }

  /** Project a row into the wire shape, holes and ledger included. */
  entryFor(resolved: ResolvedTemplate): HubTemplate {
    const { row, spec } = resolved;
    return {
      id: row.id,
      kind: row.kind as HubTemplateKind,
      name: row.name,
      description: row.description,
      revision: row.revision,
      payload: spec.payload,
      // Derived rather than stored: the holes are a function of the payload
      // (an MCP registry with `authKind: 'none'` has none, and switching it to
      // `header` changes which one), so a stored list would be a second source
      // of truth that drifts on the first edit.
      secretHoles: secretHolesFor(spec),
      provisionings: this.provisioningsFor(row.id).map((p) => ({
        hostId: p.host_id,
        remoteId: p.remote_id,
        templateRevision: p.template_revision,
        provisionedAt: p.provisioned_at,
        lastResult: p.last_result as ProvisioningOutcome,
        stale: p.template_revision !== row.revision,
      })),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Every readable template, newest first.
   *
   * A row whose payload will not parse is *skipped* rather than surfacing as a
   * broken entry, because there is nothing the UI could offer to do with it —
   * unlike a host with an undecryptable credential, which stays listed
   * precisely because re-binding fixes it. The count difference is logged by
   * the route so the discrepancy is not silent.
   */
  list(): { templates: HubTemplate[]; unreadable: number } {
    const rows = this.db
      .prepare('SELECT * FROM hub_templates ORDER BY created_at DESC')
      .all() as HubTemplateRow[];
    const templates: HubTemplate[] = [];
    let unreadable = 0;
    for (const row of rows) {
      if (isSystemTemplateId(row.id)) continue;
      const parsed = parseTemplatePayload(row.kind as HubTemplateKind, safeJson(row.payload_json));
      if (!parsed.ok) {
        unreadable += 1;
        continue;
      }
      templates.push(this.entryFor({ row, spec: parsed.value }));
    }
    return { templates, unreadable };
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

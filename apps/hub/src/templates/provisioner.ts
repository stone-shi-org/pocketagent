import type { FastifyBaseLogger } from 'fastify';
import {
  isSingletonKind,
  secretHolesFor,
  type ProvisioningItem,
  type ProvisioningOutcome,
  type ProvisioningResult,
} from '@pocketagent/protocol';
import type { HostRegistry } from '../registry/store.js';
import { describeSpec, planFor, type BackendCall, type FilledSecrets } from './kinds.js';
import type { ResolvedTemplate, TemplateStore } from './store.js';

/**
 * Ceiling on one outbound call, matching the registry routes' own
 * `BIND_TIMEOUT_MS`. A host that accepts the connection and never answers
 * would otherwise hold a provisioning run open for undici's 300 s default,
 * with the operator's freshly-typed credential in flight.
 *
 * This is not a breach of the standing no-timeout rule, which is about an
 * *approval* — a decision a human has not made yet. Nothing here is waiting
 * for a person.
 */
const CALL_TIMEOUT_MS = 20_000;

export interface ProvisionerOptions {
  readonly registry: HostRegistry;
  readonly store: TemplateStore;
  readonly fetchImpl: typeof fetch;
  readonly log: FastifyBaseLogger;
}

interface CallResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
  /** Set when the request never completed — a network error or a timeout. */
  readonly transportError: string | null;
}

/**
 * PA-70: instantiates a template onto bound hosts.
 *
 * Three properties are load-bearing, and each is a decision rather than an
 * implementation detail.
 *
 * **Nothing is written before the host is known to support the feature.**
 * Every run begins with a `GET` of the target collection; a `404` there means
 * this build has no such route and the host is reported `unsupported`, never
 * written to. Feature detection is a probe rather than a version comparison
 * because a backport, a dev build or `0.0.0-dev` makes a semver a lie about
 * which routes exist.
 *
 * **"Already provisioned" comes from this Hub's ledger, never from a name
 * match.** No backend table constrains a Pocket Agent's, a registry's or a
 * provider's name, so two may legitimately share one; matching on names could
 * therefore overwrite something a human created on that machine, which is
 * precisely the implicit overwrite the ticket forbids. A ledger row whose
 * `remote_id` no longer resolves on the host is *dropped* and the run creates
 * afresh — that is the deleted-by-hand case, and continuing to point at a
 * vanished id would strand the template forever.
 *
 * **Hosts are done one at a time.** A run over three hosts is three sequential
 * attempts each with its own outcome, because every interesting case here is a
 * partial failure and those are far easier to read — in the UI and in both
 * sides' logs — when they are ordered rather than interleaved.
 */
export class Provisioner {
  constructor(private readonly opts: ProvisionerOptions) {}

  async instantiate(input: {
    template: ResolvedTemplate;
    hostIds: readonly string[];
    secrets: FilledSecrets;
    overwrite: boolean;
  }): Promise<ProvisioningResult[]> {
    const results: ProvisioningResult[] = [];
    for (const hostId of input.hostIds) {
      results.push(await this.provisionOne(hostId, input));
    }
    return results;
  }

  private async provisionOne(
    hostId: string,
    input: {
      template: ResolvedTemplate;
      secrets: FilledSecrets;
      overwrite: boolean;
    },
  ): Promise<ProvisioningResult> {
    const { template, secrets, overwrite } = input;
    const { row: templateRow, spec } = template;
    const hostRow = this.opts.registry.getRow(hostId);
    const hostLabel = hostRow?.label ?? hostId;
    /** Set the moment a mutating call is dispatched — see `finish` below. */
    let wrote = false;

    const finish = (
      outcome: ProvisioningOutcome,
      message: string,
      remoteId: string | null,
      items: ProvisioningItem[] = [],
    ): ProvisioningResult => {
      // Recorded only when this run actually wrote to the host.
      //
      // A ledger row is a claim that this Hub put something somewhere, at a
      // known template revision — so a run that wrote nothing must not touch
      // it. `skipped` is the case that makes this load-bearing rather than
      // tidy: writing the current revision for a host that was deliberately
      // *not* re-provisioned would flip it from "behind" to "current" with
      // nothing having changed on it, silently destroying exactly the
      // staleness the no-sync model owes the operator. `unsupported`,
      // `conflict` and a precondition `failed` never reached the host either.
      // A `failed` that got past the first write *is* recorded, because the
      // resource may exist and its id is the only way to overwrite it later.
      if (outcome === 'provisioned' || outcome === 'overwritten' || (outcome === 'failed' && wrote)) {
        this.opts.store.recordProvisioning({
          templateId: templateRow.id,
          hostId,
          remoteId,
          revision: templateRow.revision,
          outcome,
        });
      }
      // The Hub's half of "logged on both sides". The backend writes its own
      // line per route it serves (`auditConfigChange`), which is the half that
      // survives this process being compromised; this one is what an operator
      // reads to see the whole run. Ids and names only — a secret reached this
      // service in a request body that pino redacts wholesale, and it must not
      // re-enter the log through here.
      this.opts.log.warn(
        {
          template: templateRow.id,
          templateName: templateRow.name,
          kind: templateRow.kind,
          revision: templateRow.revision,
          hostId,
          outcome,
          remoteId,
        },
        `provisioning: ${describeSpec(spec)} -> ${hostLabel}: ${outcome}`,
      );
      return { hostId, hostLabel, outcome, message, remoteId, items };
    };

    const resolved = this.opts.registry.resolve(hostId);
    if (resolved === null) {
      return finish('failed', `${hostLabel} is not registered, or is disabled.`, null);
    }
    if (resolved.credential === null) {
      return finish(
        'failed',
        `${hostLabel} has no usable credential. Bind it again from the Hub.`,
        null,
      );
    }

    // Required holes are checked before the first call rather than letting the
    // backend reject a half-formed body: the failure belongs to the run, and a
    // 400 from someone else's validator is a worse sentence than this one.
    for (const hole of secretHolesFor(spec)) {
      if (hole.required && !(secrets[hole.key] ?? '').length) {
        return finish('failed', `${hole.label} is required for this template.`, null);
      }
    }

    const plan = planFor(spec, secrets);
    const base = resolved.row.base_url;
    const credential = resolved.credential;
    const call = (c: BackendCall): Promise<CallResult> => this.send(base, credential, c);

    // ---- Preflight ---------------------------------------------------------
    const probe = await call({ method: 'GET', path: plan.collectionPath });
    if (probe.transportError !== null) {
      return finish('failed', `Could not reach ${hostLabel}: ${probe.transportError}`, null);
    }
    if (probe.status === 401) {
      // The same translation PA-66 makes for a proxied 401: the credential is
      // the problem, and saying "provisioning failed" would send the operator
      // looking at the template.
      return finish(
        'failed',
        `${hostLabel} rejected this Hub's credential. Bind it again from the Hub.`,
        null,
      );
    }
    if (probe.status === 404) {
      return finish(
        'unsupported',
        `${hostLabel} has no ${plan.collectionPath} — that build does not support this kind of template.`,
        null,
      );
    }
    if (!probe.ok) {
      return finish('failed', `${hostLabel} answered ${probe.status} to a read.`, null);
    }

    // ---- Create, overwrite, skip or refuse ---------------------------------
    const ledger = this.opts.store.provisioningFor(templateRow.id, hostId);
    const existing = plan.existingIds(probe.body);
    const singleton = isSingletonKind(spec.kind);

    let remoteId: string | null = plan.singletonRemoteId;
    let outcome: ProvisioningOutcome;

    if (singleton) {
      // A singleton always replaces host-wide configuration, so it always
      // needs the confirmation — including the first time. There is no
      // "create" reading of it: the host already has a planner endpoint, and
      // repointing it changes what every existing Pocket Agent chat on that
      // machine talks to.
      if (!overwrite) {
        return finish(
          'skipped',
          `Provisioning a planner endpoint replaces ${hostLabel}'s existing one for every Pocket Agent chat on it. Confirm the overwrite to proceed.`,
          plan.singletonRemoteId,
        );
      }
      outcome = 'overwritten';
    } else if (ledger?.remote_id != null && existing.includes(ledger.remote_id)) {
      if (!overwrite) {
        return finish(
          'skipped',
          `${hostLabel} already has this template. Confirm an overwrite to replace it.`,
          ledger.remote_id,
        );
      }
      remoteId = ledger.remote_id;
      outcome = 'overwritten';
    } else {
      if (ledger !== null) {
        // The resource this Hub created is gone from the host — deleted there
        // by hand. Drop the stale claim rather than trying to patch an id that
        // no longer resolves, and create afresh below.
        this.opts.store.forgetProvisioning(templateRow.id, hostId);
      }
      const clash = plan.collision(probe.body);
      if (clash !== null) {
        return finish(
          'conflict',
          `Not provisioned: ${clash.label} on ${hostLabel}, and this Hub did not create it. Rename the template's slug, or remove that one first.`,
          null,
        );
      }
      outcome = 'provisioned';
    }

    // ---- Write -------------------------------------------------------------
    const items: ProvisioningItem[] = [];

    if (outcome === 'provisioned') {
      if (plan.createCall === null) {
        // Unreachable today — only a singleton kind has no create call, and a
        // singleton never reaches `provisioned`. Stated rather than asserted
        // with a `!`, so a sixth kind that forgets one fails with a sentence
        // instead of a TypeError from inside the fetch helper.
        return finish('failed', `${describeSpec(spec)} cannot be created, only replaced.`, null);
      }
      wrote = true;
      const created = await call(plan.createCall);
      if (created.transportError !== null) {
        return finish('failed', `Could not reach ${hostLabel}: ${created.transportError}`, null);
      }
      if (!created.ok) {
        return finish(
          'failed',
          `${hostLabel} refused to create it: ${errorMessage(created)}`,
          null,
        );
      }
      remoteId = plan.remoteIdFrom(created.body);
      if (remoteId === null) {
        // The write succeeded but the Hub cannot name what it made, so it
        // could never overwrite it later. Reported rather than silently
        // recorded as a success with a null id.
        return finish(
          'failed',
          `${hostLabel} created it but answered without an id, so this Hub cannot track it.`,
          null,
        );
      }
    }

    // `updateAfterCreate` is the pocket-agent case: its create route takes a
    // name and nothing else.
    const needsUpdate = outcome === 'overwritten' || plan.updateAfterCreate;
    if (needsUpdate && remoteId !== null) {
      const update = plan.updateCall(remoteId);
      if (update !== null) {
        wrote = true;
        const applied = await call(update);
        if (applied.transportError !== null) {
          return finish(
            'failed',
            `Could not reach ${hostLabel}: ${applied.transportError}`,
            remoteId,
            items,
          );
        }
        if (!applied.ok) {
          return finish(
            'failed',
            `${hostLabel} refused the settings: ${errorMessage(applied)}`,
            remoteId,
            items,
          );
        }
      }
    }

    if (remoteId !== null) {
      for (const step of plan.steps(remoteId)) {
        wrote = true;
        const stepResult = await call(step.call);
        const failed = stepResult.transportError !== null || !stepResult.ok;
        if (!failed) {
          items.push({ label: step.label, ok: true, message: 'applied' });
          continue;
        }
        const why = stepResult.transportError ?? errorMessage(stepResult);
        if (step.optional) {
          // The documented case: a tool name this host's catalog does not
          // have. The resource is created and usable, so the run continues and
          // this is one reported item rather than a failed provisioning.
          items.push({ label: step.label, ok: false, message: why });
          continue;
        }
        return finish('failed', `${hostLabel} refused "${step.label}": ${why}`, remoteId, items);
      }
    }

    const skippedItems = items.filter((item) => !item.ok).length;
    const summary =
      outcome === 'overwritten'
        ? `Replaced ${describeSpec(spec)} on ${hostLabel}.`
        : `Created ${describeSpec(spec)} on ${hostLabel}.`;
    return finish(
      outcome,
      skippedItems === 0
        ? summary
        : `${summary} ${skippedItems} setting${skippedItems === 1 ? '' : 's'} could not be applied — see the details.`,
      remoteId,
      items,
    );
  }

  /**
   * One authenticated call to a backend.
   *
   * Never throws: a transport failure comes back as a value, because a run
   * over several hosts must not be ended by the first unreachable one — that
   * is the same "one dead host delays neither of the others" property the
   * health poller has.
   */
  private async send(baseUrl: string, credential: string, c: BackendCall): Promise<CallResult> {
    const method = c.method;
    const url = `${baseUrl.replace(/\/$/, '')}${c.path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
    try {
      const response = await this.opts.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${credential}`,
          ...(c.body === undefined || method === 'GET'
            ? {}
            : { 'content-type': 'application/json' }),
        },
        ...(c.body === undefined || method === 'GET'
          ? {}
          : { body: JSON.stringify(c.body) }),
        signal: controller.signal,
      });
      let body: unknown = null;
      // A 204 has no body, and a backend erroring behind a proxy may answer
      // HTML; neither should surface as a crash in a provisioning run.
      if (response.status !== 204) {
        body = await response.json().catch(() => null);
      }
      return { ok: response.ok, status: response.status, body, transportError: null };
    } catch (err) {
      const reason = (err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message;
      return { ok: false, status: 0, body: null, transportError: reason };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The backend's own error text where it sent one, else the bare status. */
function errorMessage(result: CallResult): string {
  const message = (result.body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === 'string' && message.length > 0 ? message : `HTTP ${result.status}`;
}

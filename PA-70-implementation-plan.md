# PA-70 — Hub config templates and provisioning to bound hosts

Implementation plan. **No code changed yet** beyond this document — there is no `agent-ready`/
`approved` label and no go-ahead comment, so this is posted for review first per the workflow.

## 0. Where this sits, and the one thing that blocks it

| Ticket | What it owns | Status in this worktree |
| --- | --- | --- |
| PA-60 | `HostEndpoint`, `#/h/<hostId>/` parsing, host-scoped API/WS client | **implemented** (`bb387c5`) |
| PA-61 | per-host protocol negotiation, real semver on `/health` | **implemented** (`afbaf35`) |
| PA-63 | scoped hub credentials — bind, list, revoke (the *backend* half) | **implemented** (`9928355`) |
| PA-64/65 | backend image, release pipeline | **implemented** (`f53d1d5`, `fe610e4`) |
| PA-66 | `apps/hub`: registry, one-origin proxy, SSO, health polling | **plan only** (`379a112`) — `apps/hub` does not exist |
| PA-67 | the multi-host UI that consumes the registry | **implemented** (`97056f3`) |
| PA-68/69 | agent installation; version drift + drain-then-exit restart | **implemented** (`8c5cb9a`, `8fadfc3`) |
| **PA-70** | templates and provisioning | this document |
| PA-71 | the docs/CLAUDE.md architecture rewrite | not started |

The ticket says "schedule it after the Hub and multi-host UI are real". Half of that is now true and
half is not: **PA-67 is real, PA-66 is not.** `apps/` contains `server` and `web` and nothing else,
and PA-66 is In Progress in Jira with its plan posted and unapproved. PA-70 has no service to live
in.

So this plan is written against PA-66's *design document* rather than against code, and it depends
on five of its decisions specifically: D1 (`apps/hub` is a Fastify service with its own SQLite
opener), D2 (`packages/node-kit` holds `secret-box.ts` — PA-66's own **question 1**), D3 (the
Hub-minted slug host id), D14 (`POCKETAGENT_SETTINGS_ENC_KEY` required on the Hub — PA-66's
**question 3**) and D23 (one `onRequest` gate, `REDACT_PATHS`, no per-request logging). If either of
those two open questions is answered the other way, the affected parts here are §3's file list and
D3 below, and nothing else.

What that means practically is in **question 6** at the end: I do not think PA-70 should be
implemented before PA-66 merges, and I would rather say so than write code against a directory that
does not exist.

## 1. What I verified in the code

Line numbers are current `feature/hub` (`8fadfc3`).

1. **Four of the five resources can already be provisioned with no new backend route at all.** Each
   has a create and an update route that the Hub can call with the bearer credential PA-63 mints:
   `POST /api/planner/workspaces` (`routes/planner.ts:201`) + `PATCH …/:id` (227);
   `POST /api/planner/workspaces/:id/tools` (657, one `{toolName, enabled}` per call);
   `POST /api/mcp-registries` (`routes/mcp-registries.ts:42`) + `PATCH /:id` (72);
   `POST /api/custom-claude-providers` (`routes/custom-claude-providers.ts:43`) + `PATCH /:id` (56);
   `POST /api/planner/models` (`routes/planner.ts:292`) and `PATCH /api/planner/settings` (362).
   That is the single most load-bearing finding in this plan: provisioning is the Hub *being an API
   client*, not a new contract between two services.
2. **Skills are the exception, and they cannot be provisioned over HTTP today.**
   `POST /api/planner/skills` (`routes/planner.ts:704`) takes
   `RegisterPlannerSkillRequest = z.object({ path: z.string().min(1) })`
   (`packages/protocol/src/planner.ts:691`) — a filesystem path **on the receiving host**. A skill's
   content lives in `<dataDir>/planner-skills/<slug>/SKILL.md` (`planner/skills.ts:129–131`) as YAML
   frontmatter plus a Markdown body (`parseSkillFile`, 162), and **no protocol type anywhere carries
   that body**: `PlannerSkillInfo` (`planner.ts:670`) is `id, slug, name, description, source,
   sourceLabel, enabled`. The only thing that writes skill content is the `write_skill` planner
   tool, which is a tool and not a route. Hence D9.
3. **The auth gate validates a hub credential and immediately forgets which Hub it was.**
   `app.ts:771` is `if (hubCredentials.validate(bearerTokenFrom(request.headers.authorization),
   request.ip)) return;` and `HubCredentialStore.validate` (`auth/hub-credentials.ts:88–100`)
   returns a boolean. Nothing downstream can name the principal, so the backend half of acceptance
   criterion 5 is not currently expressible. Hence D8.
4. **The audit precedent the ticket cites is real, and it is one line.**
   `app.log.warn({ path: added, created: !!parsed.data.create }, 'project folder added; sessions may
   now run here')` (`routes/sessions.ts:343–346`). Note the shape: `warn` rather than `info`, and it
   names the *consequence* rather than the call. It also does not name a principal, because until
   PA-63 there was only one. Exactly one other route logs a mutation today:
   `routes/auth.ts:145`, `'hub credential revoked'`.
5. **`planner_workspaces.path` is `NOT NULL UNIQUE` and absolute** (`db/index.ts:666`), and PA-62
   moved the root under the data dir — `plannerWorkspacesRoot = path.join(config.dataDir,
   'planner-workspaces')` (`app.ts:306–309`). A path is therefore host-specific by construction. The
   escape hatch already exists: `CreatePlannerWorkspaceRequest.path` is `.optional()`
   (`planner.ts:121–125`), and omitting it is the app-created-scratch-directory branch. Hence D4.
6. **A field that looks host-local turns out to be portable, and it matters for AC 1.**
   `planner_workspaces.default_model_id` has no FK (`db/index.ts:776`, deliberately, per its own
   comment) and is *not* a `planner_models` row id: `chats.ts:478` seeds `lastModelId` from
   `input.modelId ?? workspace.defaultModelId ?? settings.lastModelId`, and `llm-client.ts:225–243`
   puts that string straight into the request body's `model`. So it is the provider's own model
   *name* (`deepseek-chat`), which survives a copy to another host whose endpoint offers the same
   name — and a host whose endpoint does not is a reportable mismatch rather than a corrupt row.
7. **No table enforces a unique name for any of the five, so "is this already provisioned here?"
   cannot be answered by matching names.** The only `UNIQUE` indexes in this neighbourhood are
   `planner_agent_disabled_tools (workspace_id, tool_name)` (`db/index.ts:1127`), its skills and
   mcp-registry siblings (1173), and `planner_workspaces.path`. Two Pocket Agents may share a name;
   so may two providers and two registries. Skills are the one exception, and only because the slug
   is a directory name on disk. Hence D5.
8. **Secret handling is not uniform across the five, and two of the three create paths *require* a
   secret.** Encrypted at rest through `crypto/secret-box.ts`:
   `custom_claude_providers.api_key_ciphertext` (`db/index.ts:92–106`),
   `mcp_registries.bearer_token_ciphertext` and `header_value_ciphertext` (125–142). Stored
   **plaintext** in `settings`, with an explicit doc comment saying so: `planner_llm_api_key`,
   `planner_embedding_api_key`, `planner_web_search_api_key`, `planner_url_fetch_api_key`
   (`planner/store.ts:336–390`). Creation cannot be keyless — a provider's `apiKey` is
   `API_KEY.min(1)` (`custom-claude-providers.ts:83`) and an MCP registry `.refine`s that a bearer
   or header auth kind carries its value (`mcp-registry.ts:134–141`) — while *update* treats a blank
   secret as "keep the stored one" in both. There is no reveal route for the MCP or provider
   secrets; the planner LLM and embedding keys do have rate-limited, logged ones
   (`routes/planner.ts:424`, 438).
9. **A per-agent tool subset is validated against the receiving host's live catalog**, so a template
   that disables a tool a host does not have is a `400` rather than a harmless no-op
   (`routes/planner.ts:657` checks the full catalog; the skills and registry equivalents check by
   id). A provisioning run therefore has to treat that as a per-item outcome, not a failure.
10. **Two of the three per-agent subsets reference host-local minted ids and so are not
    expressible in a template.** `planner_agent_disabled_skills.skill_id` is `global:<slug>` or
    `<workspaceId>:<slug>` (`mintSkillId`, `skills.ts:137`), and
    `planner_agent_disabled_mcp_registries.registry_id` FKs `mcp_registries.id`, itself minted
    `mcp:<slug>-<hex>` (`mcp/registry-service.ts:699`). Tool *names* come from the global catalog and
    are stable strings. Hence D10.
11. **Creating an MCP registry makes the receiving host dial a third party.**
    `POST /api/mcp-registries` runs a connection check as part of creation
    (`routes/mcp-registries.ts:42`). Worth disclosing in the confirmation; not a reason to avoid it.
12. **Planner models and endpoints are a global singleton, not a per-agent row.** `PATCH
    /api/planner/settings` (`routes/planner.ts:362`) replaces the one endpoint every Pocket Agent
    chat on that machine uses, `DELETE /api/planner/models` (314) is a delete-*all*, and a model row
    has no PATCH at all — editing one is delete + recreate (`CreatePlannerModelRequest`,
    `planner.ts:182`). So provisioning this kind is never additive. Hence D11.
13. **The web UI already has the seam a Hub-only surface needs.** `useHostDirectory` decides
    `source: 'hub' | 'local'` once at boot and never merges the two
    (`hosts/directory.ts:46`, 232–239), and it talks to the Hub with a raw
    `fetch('/api/hub/hosts')` (150, 345) rather than a host-scoped client — correctly, since the Hub
    is an origin and not a host. A Templates page under `pages/` therefore has to be added to
    `host-scoping.test.ts`'s `ALLOWED` map with its reason (that test's own point, 28–33).
14. **Neither existing compatibility mechanism answers the question provisioning needs to ask.**
    `negotiateProtocol` (PA-61) is about the WebSocket frame set versus a compiled-in bundle, and
    `hostVersionStatus` (PA-69, `version-drift.ts`) is advisory semver comparison whose own doc
    comment calls the latest-release figure *evidence, not authority*. Neither says whether a given
    build has `POST /api/mcp-registries`. Hence D7.

## 2. Design decisions

Each records the alternative it rejected.

### D1 — Provisioning is the Hub acting as an authenticated API client, not a new backend contract

For four of the five kinds the Hub makes ordinary outbound calls to the routes in finding #1,
carrying `Authorization: Bearer pah_…` — the credential PA-63 already mints and PA-66 already
stores per host. The backend gains no provisioning endpoint, no bulk shape and no template
awareness.

That is not merely economical, it is the same rule PA-56 recorded when the planner needed to write
settings: run through *the same validation its own HTTP route does — never a second copy*, which is
why `resolveWebhookUpdatePatch` was factored out of `routes/webhooks.ts` rather than reimplemented.
A `POST /api/provision` taking five resource kinds would be a second copy of five validators, and
the first one to drift would drift silently on every bound host at once.

Rejected: a bulk provisioning endpoint on the backend (above); and having the Hub write the
backend's SQLite directly (it has no access, must not have, and every one of these resources has
side effects beyond its row — a provider re-registers an `AgentAdapter`, a registry connects).

### D2 — A template is Hub-side rows, and its payload schema lives in `packages/protocol`

`hub_templates (id, kind, name, description, revision, payload_json, created_at, updated_at)` in the
Hub's own database, with one Zod schema per kind in a new
`packages/protocol/src/hub-templates.ts`. The schemas live in the shared package for the reason
`hub-registry.ts:14–22` already records for itself and `cron-expr.ts`/`webhook-template.ts` record
before it: the Hub validates a template on write and the browser's editor validates it while
typing, and a shape invented twice eventually disagrees.

`kind` is a closed enum — `pocket-agent`, `mcp-registry`, `claude-provider`, `skill`,
`planner-endpoint` — and `payload_json` is parsed through that kind's schema on read as well as
write, so a row hand-edited into the database cannot reach an outbound request unvalidated.

Rejected: a YAML/JSON file format with import/export in v1. It is the obvious next feature and it is
genuinely useful, but it turns "add a field" into a file-format migration, and nothing in the
acceptance criteria asks for it. Noted as a follow-up rather than designed around.

### D3 — The Hub never stores a secret value, not even encrypted

A template declares its **secret-shaped holes** (which fields, and what each is for). The values are
supplied in the *instantiate request body*, used for exactly one outbound call, and never written to
the Hub's database. Re-provisioning asks again.

The enforcement is structural rather than a rule someone has to remember: the template tables have
no column a secret could go in, and the one place a secret exists in the Hub is a request body,
which PA-66 D14/D23 already redacts wholesale in the copied pino config.

Rejected: storing the filled holes encrypted per `(template, host)` so re-provisioning is one click.
It is the friendlier design and I think it is the wrong one here. The ticket's own security note says
the Hub's credential concentration is what bites, and this would move the Hub from "holds a revocable
credential per host" to "holds a revocable credential per host **plus** every third-party API key the
fleet uses" — provider keys, MCP server tokens, four planner keys per host — none of which is
revocable from this product at all. `POCKETAGENT_SETTINGS_ENC_KEY` on one box would then be the
single thing standing between a Hub compromise and every upstream account the fleet talks to. The
cost of refusing is re-typing a key on re-provision, which finding #8 shows is already the shape the
backend's own editors use (blank means keep). This is **question 1**.

### D4 — Host-shaped holes are a second class beside secret-shaped ones, and `path` is the first member

A Pocket Agent template carries no `path` and no `createPath` — the fields are absent from the
schema, so this is not a runtime check that a later refactor can drop. Instantiation always uses the
app-created-directory branch (finding #5), and the receiving host mints its own directory under its
own `POCKETAGENT_DATA_DIR`.

Rejected: carrying `path`. It is wrong on any host whose data dir differs, which is every
containerised host by design. And rejected more firmly than that: carrying `path` + `createPath` as
an optional override would mean one Hub action could create directories on every bound host and hand
that agent's `write_file`/`exec_command`/`rmdir` tools full read/write/delete trust over them — the
deliberate widening CLAUDE.md documents for `PlannerWorkspaceRegistry.create`'s `opts.path`,
performed in bulk, remotely, by a service whose compromise the ticket already names as the risk. If
an operator wants a Pocket Agent pointed at a real directory on one machine, that is a per-host edit
in that host's own editor, which already exists and already discloses what it does.

The general rule this establishes: a template field is portable only if its *value* means the same
thing on every host. Absolute paths and host-local minted ids do not qualify (findings #5, #10);
model names and tool names do (findings #6, #10).

### D5 — Re-provision detection comes from a Hub-side ledger, never from a name match

`hub_provisionings (id, template_id, host_id, kind, remote_id, template_revision, provisioned_at,
last_result)`, `ON DELETE CASCADE` from both the template and the host row — it is a cache of "what
this Hub put where", not history, the same call `webhook_issue_sessions` and `telegram_links` make
for the same reason.

"Already provisioned on this host" means: a ledger row exists **and** its `remote_id` still resolves
in that host's own collection `GET`. Overwrite is then a `PATCH` of that exact `remote_id`, behind an
explicit confirmation naming the host and the resource.

Rejected: matching by name. Finding #7 is the argument — names are not unique in any of these
tables, so a name match can select a resource a human created by hand on that machine and silently
replace it, which is precisely the implicit overwrite acceptance criterion 3 forbids. Also rejected:
always creating (a duplicate Pocket Agent per provisioning run).

Skills are the one kind where the host *does* enforce uniqueness, by the filesystem (finding #7). So
a skill whose slug already exists on a host with no ledger row is reported as a **conflict and
refused**, not overwritten — the operator either renames or confirms an overwrite of that specific
slug.

### D6 — Editing a template never touches a provisioned host; staleness is shown, not corrected

`hub_templates.revision` increments on every edit, and the ledger keeps the revision that was
actually sent. The UI then says "dev01 has r3, this template is r5" and offers re-provisioning as a
deliberate act.

This is the whole of acceptance criterion 2, and the visibility half is not decoration: the no-sync
model owes the operator exactly one thing in exchange for never correcting drift, which is the
ability to see that it exists.

Rejected: a reconciliation loop (the ticket rules it out, and for the reason it gives — it would
fight the per-host editors that exist on every one of these resources). Also rejected: recording
nothing, which makes "which hosts are behind?" unanswerable.

### D7 — Feature detection is a probe of the target route, not a version comparison

Before the first write of a provisioning run, the Hub issues the target kind's collection `GET` on
that host. A `404` means "this build does not have this feature" and is reported in those words; a
`401`/`403` means the stored credential is no longer good and surfaces as PA-66 D21's
`host_credential_rejected` rather than as a provisioning error.

Rejected: gating on `HostInfo.version` (finding #14 — a backport, a dev build or `0.0.0-dev` makes
the semver a lie about which routes exist), and gating on `negotiateProtocol` (it describes the
WebSocket frame set and has nothing to say about REST). PA-69's drift badge stays what it is:
advisory.

### D8 — The backend logs the provisioning too, and that is the one change to `apps/server`

Acceptance criterion 5 wants both sides, and the backend's log is the more important of the two: it
is the only record that survives the Hub compromise the ticket names as the threat. Today it cannot
be written, because the gate forgets which Hub called (finding #3).

Three small edits, in this order:

* `HubCredentialStore.validate` returns the matched row (or `null`) instead of a boolean.
* `app.ts`'s single `onRequest` gate attaches `{ hubId, label }` to the request when that is what
  authenticated it — and *only* there, so no route acquires a second auth path, which is the
  property that gate's own comment (`app.ts:755–770`) exists to protect.
* The create/update handlers for the five kinds log one line each, in the shape finding #4
  establishes: a `warn`, naming the consequence and the principal —
  `{ hubId, label, workspace: id, name }, 'pocket agent created by hub provisioning'`.

Never the secret, never the request body: the values in those lines are ids and names only, the same
discipline the invariants list already states for provider mutations ("an audit line must not be one
step away from recovering a credential").

Rejected: logging only on the Hub (criterion 5 says both, and a Hub writing its own audit trail is
the one log an attacker who owns the Hub can edit). Also rejected: a generic "log every mutation by a
hub principal" hook in `app.ts` — it cannot name *what* was written, which is the only part of the
line with any forensic value, and it would log every unrelated route a Hub touches while proxying a
human's browsing.

### D9 — Skills need a content-carrying route, and it is the only new backend surface here

New `POST /api/planner/skills/import`, body `{ slug, name, description, body }`, writing
`<planner-skills root>/<slug>/SKILL.md` through `SkillRegistryService` — reusing its existing slug
validation (`isValidSkillSlug`, `skills.ts:53`), its containment resolution and its refresh, never a
second file writer.

Rejected: reusing `POST /api/planner/skills`. Finding #2 is the reason: it takes a path on the
receiving host, which the Hub cannot know, must not guess, and could not supply without first
getting the content onto that filesystem by some other means — of which there is none, and inventing
one would route around every check in `skills.ts`.

Two scope lines, stated rather than discovered later. v1 provisions **global** skills only
(`<dataDir>/planner-skills/<slug>/`), not per-agent `<workspace>/.skills/`. And a template carries
**one `SKILL.md`**, not a directory tree — `SkillRegistryService.copyInto` can copy auxiliary files,
so a skill with them is real, and a template that silently dropped them would be worse than one that
refuses. Provisioning such a skill is refused with that reason.

Worth being explicit about what this route *is*, since PA-68's invariant is fresh: it accepts
content that an agent will later follow as instructions. That is not the same class of thing as
`POST /api/agents/install` (which is why that one takes an id from a closed set and never a package
name) — a skill body is data the model reads, not a package the server executes — but it is
consequential enough that it is a logged, authenticated write with a slug-shaped name and no path
component, and it can only land in the app-owned skills root.

### D10 — Per-agent subsets: tools yes, skills and MCP registries no

A Pocket Agent template carries `disabledTools` (stable catalog names, finding #10) plus `name`,
`defaultModelId`, `identityPrompt`, `memoryEnabled` and `mcpEnabled`. It does **not** carry disabled
skills or disabled MCP registries, because those reference ids minted on the host that owns them.

An unknown tool name is a **per-item skipped outcome**, reported on the run, not a failed
provisioning — finding #9 means the route would otherwise `400` the whole thing because a host is one
release behind on the tool catalog.

Rejected: resolving skill and registry references through the ledger so a template could disable
things it also provisioned. It is coherent and it is a second feature; it needs the ordering
guarantees of a dependency graph between templates, and nothing in the acceptance criteria asks for
it.

### D11 — Planner models and endpoints provision as an explicit host-wide overwrite, never as an add

Finding #12: this kind is a singleton. So its template is `{ baseUrl, models[], embeddingBaseUrl,
embeddingModelId, webSearchBaseUrl, urlFetchBaseUrl }` with four secret-shaped holes, it is always
presented as replacing what the host has (showing the current `baseUrl` and model count in the
confirmation), and it never touches `yoloEnabled` — that is `planner_yolo_enabled`, the fourth
skip-permissions override's own bypass switch, and a template is not a way to turn an approval gate
off on a fleet.

Rejected: treating it like the additive kinds (it is the one kind that can break every existing chat
on the receiving host, by repointing the endpoint their transcripts were written against). Also
rejected: including `maxToolIterations`, `meInstruction` and `toolsInstruction` in v1 — they are
portable and harmless, but they belong to a "global planner settings" template that nobody has asked
for, and bundling them with the endpoint means one confirmation covering two unrelated blast radii.

### D12 — A provider template may carry `allowUnattended`, off unless set, and the confirmation says what it grants

PA-28 made that flag off by default in the column, in the create request *and* in the editor,
warned about inline and surfaced on the row rather than only at creation. A template that flipped it
on across a fleet in one action would be a real widening of the attended-use rule, so: it is carried
(an operator provisioning unattended runners should not have to visit five machines), it defaults
off, and the per-host confirmation names what it permits — scheduled jobs and inbound webhooks
running on a third-party gateway.

Rejected: refusing to carry it (the per-host visit is the whole thing this ticket exists to remove);
and carrying it silently as just another boolean.

### D13 — One host at a time, sequentially, with a per-host result row

A provisioning run over N hosts is N sequential attempts, each recording its own outcome
(`provisioned`, `overwritten`, `skipped`, `conflict`, `unsupported`, `failed`) with a
human-readable reason. Acceptance criterion 1 needs two hosts; the interesting cases are all partial
failures, and those are far easier to present and to read in the audit log when they are ordered.

Rejected: parallel fan-out. It buys wall-clock time on an operation an operator performs once per
machine, at the cost of interleaved logs on both sides.

### D14 — A Hub-only Templates surface in the existing bundle

Gated on `useHostDirectory().source === 'hub'` (finding #13), so a standalone install renders exactly
as it does today — the property PA-67's whole design is built on. It lives in `apps/web` because
PA-66 D16 already decided the Hub serves this same bundle and a second frontend means every page
exists twice. And it goes on `host-scoping.test.ts`'s `ALLOWED` map with its reason, because it
deliberately talks to the Hub origin rather than to a host — which is the same exemption
`LoginPage.tsx` already carries and for a closely related reason.

## 3. Files

Everything under `apps/hub/` presumes PA-66 has landed (§0).

**New**

| File | Purpose |
| --- | --- |
| `packages/protocol/src/hub-templates.ts` | `HubTemplateKind`, one payload schema per kind, `SecretHole`, CRUD and instantiate request/response shapes, `ProvisioningOutcome` (D2) |
| `apps/hub/src/templates/store.ts` | `hub_templates` + `hub_provisionings` rows, revision bump on edit (D2, D5, D6) |
| `apps/hub/src/templates/routes.ts` | template CRUD + `POST /api/hub/templates/:id/instantiate` |
| `apps/hub/src/templates/provisioner.ts` | the outbound client: preflight probe, create-or-overwrite, per-item outcomes, audit lines (D1, D5, D7, D13) |
| `apps/hub/src/templates/kinds/*.ts` | one module per kind mapping a payload + filled holes onto that kind's backend requests |
| `apps/hub/tests/templates-*.test.ts` | see §5 |
| `apps/hub/scripts/provision-demo.mjs` | the live demo (§5) |
| `apps/web/src/pages/HubTemplatesPage.tsx` | the Hub-only surface (D14) |
| `apps/web/src/pages/HubTemplateEditorPage.tsx` | one template, following the `CronJobEditorPage`/`WebhookEditorPage` prop contract |
| `apps/server/src/routes/planner-skills-import.ts` *(or a handler in `routes/planner.ts`)* | `POST /api/planner/skills/import` (D9) |

**Changed**

`packages/protocol/src/index.ts` (one re-export line) · `packages/protocol/src/planner.ts`
(`ImportPlannerSkillRequest`) · `apps/server/src/auth/hub-credentials.ts` (`validate` returns the
row) · `apps/server/src/app.ts` (the gate attaches the hub principal; `types.d.ts` for the request
decoration) · `apps/server/src/routes/{planner,mcp-registries,custom-claude-providers}.ts` (one audit
`warn` per create/update, and the skills import handler) · `apps/server/src/planner/skills.ts` (an
import entry point if `SkillRegistryService` needs one) · `apps/web/src/hooks/useHashRoute.ts` (two
route variants, detail-before-generic) · `apps/web/src/hosts/host-scoping.test.ts` (two allowlist
entries with reasons) · `apps/web/src/api/client.ts` + `components/Icon.tsx` + `styles.css` as
needed · `apps/hub/src/app.ts` (register the new routes) · root `package.json` (`demo:provision`) ·
`eslint.config.js` (the new demo script in the browser-globals list) · `README.md`, `CLAUDE.md`,
Confluence.

## 4. Phases

Each ends with `pnpm build && pnpm typecheck && pnpm lint && pnpm test` green.

0. **(Blocking) PA-66 merges.** Nothing below can start first.
1. **Backend half.** The hub principal on the request, the five audit lines, and
   `POST /api/planner/skills/import`. This phase is independently reviewable, ships against a
   standalone backend with no Hub in sight, and is the only part that touches `apps/server`.
2. **Templates, no provisioning.** Protocol schemas, `hub_templates`, CRUD, the editor. A template
   can be defined and edited and does nothing.
3. **Provisioning one kind: `pocket-agent`.** The provisioner, the preflight probe, the ledger, the
   confirm-to-overwrite flow. This is where acceptance criteria 1, 2 and 3 are met, on the exact kind
   criterion 1 names.
4. **The remaining kinds.** `mcp-registry` and `claude-provider` (the secret-hole mechanism under
   real load, two different secret shapes), then `skill`, then `planner-endpoint` (D11's overwrite
   confirmation).
5. **Ship.** `demo:provision`, README/CLAUDE.md/Confluence, PA-71 coordination.

Phase 3 is the review that matters; phases 4's kinds are repetitions of a decided shape.

## 5. Verification

**Unit / integration** — in the `hub` vitest project PA-66 adds, using its `createTestHub()` helper
against a **real listening** backend (`createTestApp()` + `listen({ port: 0 })`), because the whole
subject is outbound HTTP.

* `templates-secrets.test.ts` — acceptance criterion 4, asserted the way PA-66's `bind.test.ts`
  asserts its own: after defining every kind of template and provisioning each onto two hosts, a
  scan of **every column of every row** of the Hub database contains none of the secret values. Plus:
  the captured Hub log output contains none of them either.
* `templates-provision.test.ts` — criterion 1: one `pocket-agent` template, two hosts, both end up
  with a working agent, each with its own secret entered separately; and the two remote ids differ
  and are both in the ledger.
* `templates-divergence.test.ts` — criterion 2: provision, edit the template (revision bumps), and
  assert the host's resource is **byte-identical to before** on every field, with the staleness
  surfaced in the host list.
* `templates-overwrite.test.ts` — criterion 3: re-provisioning without the confirm flag is refused
  and writes nothing; with it, it `PATCH`es the ledger's `remote_id` and creates no second resource.
  And the name-collision case that D5 exists for: a resource created *by hand* on the host with the
  same name is never touched.
* `templates-skill-conflict.test.ts` — a slug that already exists with no ledger row is a reported
  conflict, not an overwrite (D5, D9).
* `templates-preflight.test.ts` — a host whose collection route 404s is reported `unsupported` and
  **is never written to** (asserted on a request counter in the upstream, the shape PA-66's
  allowlist test already uses); a 401 surfaces as `host_credential_rejected` and not as a
  provisioning failure.
* `templates-partial.test.ts` — an unknown tool name is one `skipped` item with the rest applied
  (D10, finding #9); one dead host in a three-host run does not stop the other two, and each has its
  own outcome row.
* `templates-audit.test.ts` — criterion 5, both halves: the Hub logs one line per action, and the
  **backend's** captured log names the `hubId` and the resource for each (this is the test that
  fails today for the reason finding #3 gives).
* `apps/server` — the existing suite must stay green; `hub-credentials.test.ts` is the guard on the
  `validate` signature change, and a new case there asserts the principal is attached for a hub
  credential and *absent* for a cookie session.
* `apps/web` — `host-scoping.test.ts` stays green with its two new allowlist entries, which is what
  proves the Templates pages are deliberately Hub-scoped rather than accidentally host-scoped.

**Live demo** — `pnpm demo:provision`, against two scratch backends with throwaway data roots
(`POCKETAGENT_DATA_DIR`, per the demo rule): define a Pocket Agent template in the browser,
instantiate it on both hosts entering a different key each time, open each host's own Settings page
and see the agent, edit the template and show both hosts unchanged with a staleness note, then
re-provision one with the confirmation dialog. Phone and desktop viewports, since D14 puts this in
the shared bundle.

**Docs, in the same change** — README (a "Provisioning from a Hub" section, and the secret-holes
posture from D3); CLAUDE.md (the templates model, D3/D4/D5/D8, the new unauthenticated-surface-free
route, and the "a template field is portable only if its value means the same thing on every host"
rule); Confluence **Architecture Overview**, **Invariants & Security Model** (the audit-both-sides
rule and the no-stored-secrets property), **Key Workflows** (define once, instantiate twice),
**Development Guide** (`demo:provision`). Coordinated with PA-71 rather than duplicating it: I will
write the statements of fact this change makes true and leave the architecture rewrite to that
ticket.

## 6. Risks, and what I would cut first

* **The dependency is the risk.** PA-70 is written against a design document, and PA-66 has five
  open questions of its own. Two of them (its Q1 and Q3) reach into this plan. Implementing before
  PA-66 merges means rewriting §3 at minimum.
* **Scope.** Five kinds is five times the surface of one, and the ticket itself calls this the
  largest and least certain in the set. The honest cut is after phase 3: `pocket-agent` alone
  satisfies acceptance criteria 1–3 as literally written, and the remaining kinds are a coherent
  second change. If more has to go, `planner-endpoint` (D11) is the first I would drop — it is the
  only host-wide overwrite in the set and the only one that can break existing chats.
* **D9 is the only new route, and it is the one to argue about.** If the appetite for a
  content-accepting skills endpoint is low, skills leave v1 and nothing else in the plan changes.
* **D3 will be unpopular in use.** Re-typing a provider key on every re-provision is friction, and
  the friction lands on the operator who is doing the right thing. I still recommend it, and I would
  rather revisit it with real usage than build the key store first.
* **The backend's audit lines are load-bearing but easy to under-do.** One `warn` per route is
  trivial to write and trivial to forget on the sixth route added later; `templates-audit.test.ts`
  covers the five that exist, and nothing structurally forces the next one.

## 7. Questions

1. **D3** — the Hub stores **no** secret values at all, so re-provisioning re-prompts for keys. The
   alternative is storing the filled holes encrypted per `(template, host)` for one-click
   re-provisioning, at the cost of the Hub holding every upstream key the fleet uses. I strongly
   recommend not storing them. Confirm?
2. **D9** — `POST /api/planner/skills/import` is the only new backend route in this plan, and it
   accepts skill *content* (instructions an agent will follow). Approve it, or cut skills from PA-70?
3. **Scope** — do you want all five kinds, or phase 3's `pocket-agent` only (which meets acceptance
   criteria 1–3 as written) with the rest as a follow-up ticket?
4. **D11** — should `planner-endpoint` be in scope at all? It is the one kind whose provisioning
   overwrites host-wide configuration and repoints the LLM endpoint for every existing Pocket Agent
   chat on the receiving machine.
5. **D8** — this adds the one change to `apps/server`: `HubCredentialStore.validate` returns the row,
   the gate attaches `{ hubId, label }`, and five routes each log a line. Confirm, or would you
   rather the backend-side audit trail be its own ticket?
6. **Sequencing** — PA-66 is not implemented and `apps/hub` does not exist. I recommend holding
   PA-70 until it merges. Do you want me to hold, or to implement phase 1 (the `apps/server` half,
   which stands alone and needs no Hub) now and the rest after?

Reply "go ahead" (or add `agent-ready` / `approved`) and I will implement it, run
build/typecheck/lint/test plus the new demo, and rebase onto `main` before committing.

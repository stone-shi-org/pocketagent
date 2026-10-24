import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BAMBOO_SAMPLE_PAYLOAD, JIRA_SAMPLE_PAYLOAD } from '@pocketagent/protocol';
import {
  insertWebhook,
  readWebhookRouteCache,
  readWebhookRouteCacheEntry,
} from '../src/db/index.js';
import { normalizeGitRemoteUrl } from '../src/webhooks/route-detect.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

let ctx: TestApp;

beforeEach(async () => {
  ctx = await createTestApp();
});

afterEach(async () => {
  await ctx.cleanup();
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function initRepo(
  dir: string,
  opts?: {
    remoteUrl?: string;
    commits?: { subject: string; body?: string }[];
    branches?: string[];
  },
): string {
  fs.mkdirSync(dir, { recursive: true });
  const real = fs.realpathSync(dir);
  git(real, ['init', '-b', 'main']);
  if (opts?.remoteUrl) {
    git(real, ['remote', 'add', 'origin', opts.remoteUrl]);
  }
  const commits = opts?.commits ?? [{ subject: 'initial commit' }];
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i]!;
    fs.writeFileSync(path.join(real, `file-${i}.txt`), `${c.subject}\n`);
    git(real, ['add', `file-${i}.txt`]);
    const commitArgs = ['commit', '-m', c.subject];
    if (c.body) commitArgs.push('-m', c.body);
    git(real, commitArgs);
  }
  for (const branch of opts?.branches ?? []) {
    git(real, ['branch', branch]);
  }
  return real;
}

const sign = (secret: string, body: string): string =>
  `sha256=${crypto.createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;

function jiraPayloadFor(issueKey: string, over: Record<string, unknown> = {}): string {
  const projectKey = issueKey.split('-')[0] ?? 'PA';
  const base = JIRA_SAMPLE_PAYLOAD as Record<string, unknown>;
  const baseIssue = (base.issue ?? {}) as Record<string, unknown>;
  const baseFields = (baseIssue.fields ?? {}) as Record<string, unknown>;
  return JSON.stringify({
    ...base,
    timestamp: Date.now(),
    issue: {
      ...baseIssue,
      key: issueKey,
      fields: {
        ...baseFields,
        project: { key: projectKey, name: projectKey },
      },
    },
    ...over,
  });
}

function bambooPayloadFor(planKey: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...(BAMBOO_SAMPLE_PAYLOAD as Record<string, unknown>),
    timestamp: String(Date.now()),
    planKey,
    buildResultKey: `${planKey}-42`,
    ...over,
  });
}

const post = (url: string, payload?: unknown) =>
  ctx.app.inject({
    method: 'POST',
    url,
    headers: authHeaders(ctx.cookie),
    ...(payload !== undefined ? { payload } : {}),
  });

const patch = (url: string, payload: unknown) =>
  ctx.app.inject({
    method: 'PATCH',
    url,
    headers: authHeaders(ctx.cookie),
    payload,
  });

const get = (url: string) =>
  ctx.app.inject({
    method: 'GET',
    url,
    headers: authHeaders(ctx.cookie),
  });

function deliverJira(slug: string, secret: string, body: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/hooks/${slug}`,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature': sign(secret, body),
    },
    payload: body,
  });
}

function deliverBamboo(slug: string, token: string, body: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/hooks/${slug}`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    payload: body,
  });
}

describe('webhook route auto-detection, cache, and suggest/auto policy (PA-170)', () => {
  it('normalizes SSH and HTTPS git remote URLs consistently', () => {
    expect(normalizeGitRemoteUrl('git@github.com:Acme/ Billing-Service.git ')).toBe(
      'github.com/acme/ billing-service',
    );
    expect(normalizeGitRemoteUrl('git@github.com:Acme/Billing-Service.git')).toBe(
      'github.com/acme/billing-service',
    );
    expect(normalizeGitRemoteUrl('https://github.com/Acme/Billing-Service.git/')).toBe(
      'github.com/acme/billing-service',
    );
    expect(normalizeGitRemoteUrl('ssh://git@github.com/Acme/Billing-Service')).toBe(
      'github.com/acme/billing-service',
    );
  });

  it('defaults new webhooks to autoRoute="suggest" and migrated database rows to autoRoute="off"', async () => {
    const createdRes = await post('/api/webhooks', {
      name: 'New Jira Hook',
      slug: 'new-jira-hook',
      cwd: ctx.projectDir,
      agent: 'claude',
      config: { type: 'jira', filter: {} },
    });
    expect(createdRes.statusCode).toBe(201);
    expect(createdRes.json().webhook.autoRoute).toBe('suggest');

    // Simulate a legacy row inserted without `auto_route` (uses DB default 'off').
    const now = Date.now();
    insertWebhook(ctx.app.pocket.db, {
      id: 'legacy-hook-id',
      name: 'Legacy Hook',
      slug: 'legacy-hook',
      enabled: 1,
      type: 'jira',
      auth_mode: 'hmac',
      secret: 'legacy-secret',
      auth_token_hash: null,
      secret_set_at: now,
      filter_json: '{}',
      project_map_json: '[]',
      prompt_template_map_json: '[]',
      cwd: ctx.projectDir,
      agent: 'claude',
      worktree_mode: 'none',
      model: null,
      effort: null,
      effort_set: 0,
      skip_permissions: 0,
      auto_select_agent_model: 0,
      prompt_template: 'Hello {{issue.key}}',
      conversation_mode: 'per-delivery',
      overlap_policy: 'skip',
      directory_policy: 'queue',
      skip_queue_label_enabled: 0,
      agent_identity: '',
      max_concurrent: 2,
      store_payloads: 1,
      created_at: now,
      updated_at: now,
      last_delivery_at: null,
      last_delivery_status: null,
      last_error: null,
    });

    const getLegacy = await get('/api/webhooks/legacy-hook-id');
    expect(getLegacy.statusCode).toBe(200);
    expect(getLegacy.json().autoRoute).toBe('off');
  });

  it('detects unambiguous Jira project key from git commits and branches (including worktrees) and suggests under suggest policy, then routes after Accept', async () => {
    const repoOther = initRepo(path.join(ctx.workspaceRoot, 'repo-other'), {
      commits: [
        { subject: '[OTH-1] Initial setup' },
        { subject: '[OTH-2] Add config' },
        { subject: '[OTH-3] Fix lint' },
      ],
    });
    const repoBilling = initRepo(path.join(ctx.workspaceRoot, 'repo-billing'), {
      remoteUrl: 'https://github.com/example/repo-billing.git',
      commits: [
        { subject: '[BIL-10] Add invoice schema' },
        { subject: 'Fix tax calculation', body: 'Resolves BIL-11 and BIL-12' },
        { subject: '[BIL-13] Handle refunds' },
        { subject: '[BIL-14] Stripe webhook retry' },
      ],
      branches: ['feature/BIL-15-export'],
    });
    // Add a linked worktree under repoBilling/.worktrees/feature-bil-16 to
    // verify `treeRootOf` worktree scanning rolls up to `repoBilling` rather
    // than tying against it as a competing candidate.
    const wtDir = path.join(repoBilling, '.worktrees', 'feature-bil-16');
    git(repoBilling, ['worktree', 'add', '-b', 'feature/BIL-16-worktree', wtDir]);

    const createRes = await post('/api/webhooks', {
      name: 'Multi-project Hook',
      slug: 'multi-proj',
      cwd: repoOther,
      agent: 'claude',
      autoRoute: 'suggest',
      config: {
        type: 'jira',
        filter: {},
        projectMap: [{ projectKey: 'OTH', cwd: repoOther }],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const { webhook, secret } = createRes.json();

    // Deliver an event for unmapped project BIL.
    const delivRes = await deliverJira(webhook.slug, secret, jiraPayloadFor('BIL-99'));
    expect(delivRes.statusCode).toBe(202);
    const outcome = delivRes.json();
    expect(outcome.status).toBe('filtered');
    expect(outcome.reason).toContain('no mapping for BIL; suggested');
    expect(outcome.reason).toContain('repo-billing');
    expect(outcome.reason).toContain('4 commits and 2 branches mention BIL-');

    // Verify delivery list includes `routeSuggestion`.
    const listRes = await get(`/api/webhooks/${webhook.id}/deliveries`);
    expect(listRes.statusCode).toBe(200);
    const bilDelivery = listRes.json().deliveries[0];
    expect(bilDelivery.status).toBe('filtered');
    expect(bilDelivery.routeSuggestion).toMatchObject({
      webhookId: webhook.id,
      routeKey: 'BIL',
      cwd: repoBilling,
      source: 'git-history',
      confidence: 'unambiguous',
      confirmedAt: null,
    });

    // Accept the suggestion.
    const acceptRes = await post(`/api/webhooks/${webhook.id}/routes/BIL/accept`, {});
    expect(acceptRes.statusCode).toBe(200);
    const acceptedBody = acceptRes.json();
    expect(acceptedBody.entry.confirmedAt).toEqual(expect.any(Number));
    expect(acceptedBody.entry.confirmedBy).toBe('operator');
    expect(acceptedBody.webhook.config.projectMap).toEqual(
      expect.arrayContaining([
        { projectKey: 'OTH', cwd: repoOther },
        { projectKey: 'BIL', cwd: repoBilling },
      ]),
    );

    // Next delivery for BIL now routes and starts a run in repoBilling.
    const secondRes = await deliverJira(webhook.slug, secret, jiraPayloadFor('BIL-100'));
    expect(secondRes.statusCode).toBe(202);
    expect(secondRes.json().status).toBe('running');
  });

  it('auto-routes unambiguous matches when autoRoute="auto" and records disclosure on the delivery row', async () => {
    const repoOther = initRepo(path.join(ctx.workspaceRoot, 'repo-other'), {
      commits: [{ subject: '[OTH-1] Init' }],
    });
    const repoPayments = initRepo(path.join(ctx.workspaceRoot, 'repo-payments'), {
      commits: [
        { subject: '[PAY-1] Init payments' },
        { subject: '[PAY-2] Add ledger' },
        { subject: '[PAY-3] Settlement batch' },
        { subject: '[PAY-4] Reconciliation' },
      ],
    });

    const createRes = await post('/api/webhooks', {
      name: 'Auto Route Hook',
      slug: 'auto-route-hook',
      cwd: repoOther,
      agent: 'claude',
      worktreeMode: 'none',
      autoRoute: 'auto',
      config: {
        type: 'jira',
        filter: {},
        projectMap: [{ projectKey: 'OTH', cwd: repoOther }],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const { webhook, secret } = createRes.json();

    const delivRes = await deliverJira(webhook.slug, secret, jiraPayloadFor('PAY-50'));
    expect(delivRes.statusCode).toBe(202);
    const body = delivRes.json();
    expect(body.status).toBe('running');
    expect(body.reason).toContain('auto-routed via git-history:');
    expect(body.reason).toContain('repo-payments');
    expect(body.reason).toContain('4 commits mention PAY-');

    const deliveries = (await get(`/api/webhooks/${webhook.id}/deliveries`)).json().deliveries;
    expect(deliveries[0].cwd).toBe(repoPayments);
    expect(deliveries[0].reason).toContain('auto-routed via git-history:');
  });

  it('falls back to suggest under autoRoute="auto" when mentions are too few (1-2 stray mentions) or tied across two repos', async () => {
    const repoBase = initRepo(path.join(ctx.workspaceRoot, 'repo-base'), {
      commits: [{ subject: '[BASE-1] Init' }],
    });
    // Repo A and Repo B tie on project TIE (4 commits each), and Repo A has only 2 stray mentions of LOW.
    initRepo(path.join(ctx.workspaceRoot, 'repo-alpha'), {
      commits: [
        { subject: '[TIE-1] Alpha work 1' },
        { subject: '[TIE-2] Alpha work 2' },
        { subject: '[TIE-3] Alpha work 3' },
        { subject: '[TIE-4] Alpha work 4' },
        { subject: '[LOW-1] Stray mention 1' },
        { subject: '[LOW-2] Stray mention 2' },
      ],
    });
    initRepo(path.join(ctx.workspaceRoot, 'repo-beta'), {
      commits: [
        { subject: '[TIE-5] Beta work 1' },
        { subject: '[TIE-6] Beta work 2' },
        { subject: '[TIE-7] Beta work 3' },
        { subject: '[TIE-8] Beta work 4' },
      ],
    });

    const createRes = await post('/api/webhooks', {
      name: 'Ambiguous Guard Hook',
      slug: 'ambiguous-guard',
      cwd: repoBase,
      agent: 'claude',
      autoRoute: 'auto',
      config: {
        type: 'jira',
        filter: {},
        projectMap: [{ projectKey: 'BASE', cwd: repoBase }],
      },
    });
    const { webhook, secret } = createRes.json();

    // 1. Tie across two repos must NOT auto-route; it must filter and name both candidates.
    const tieRes = await deliverJira(webhook.slug, secret, jiraPayloadFor('TIE-99'));
    expect(tieRes.statusCode).toBe(202);
    expect(tieRes.json().status).toBe('filtered');
    expect(tieRes.json().reason).toContain('no mapping for TIE; suggested');
    expect(tieRes.json().reason).toContain('repo-alpha');
    expect(tieRes.json().reason).toContain('repo-beta');

    // 2. 1-2 stray mentions must NOT auto-route either; stays suggest.
    const lowRes = await deliverJira(webhook.slug, secret, jiraPayloadFor('LOW-10'));
    expect(lowRes.statusCode).toBe(202);
    expect(lowRes.json().status).toBe('filtered');
    expect(lowRes.json().reason).toContain('no mapping for LOW; suggested');
    expect(lowRes.json().reason).toContain('2 commits mention LOW-');
  });

  it('matches Bamboo plan repositoryUrl against workspace git remotes and supports dismiss', async () => {
    const repoDefault = initRepo(path.join(ctx.workspaceRoot, 'repo-default'), {
      remoteUrl: 'https://github.com/acme/default-service.git',
    });
    const repoMobile = initRepo(path.join(ctx.workspaceRoot, 'repo-mobile'), {
      remoteUrl: 'git@github.com:acme/mobile-app.git',
    });

    const createRes = await post('/api/webhooks', {
      name: 'Bamboo Auto Route',
      slug: 'bamboo-auto',
      cwd: repoDefault,
      authMode: 'bearer',
      agent: 'claude',
      autoRoute: 'suggest',
      config: {
        type: 'bamboo',
        filter: {},
        planMap: [{ planKey: 'DEF-MAIN', cwd: repoDefault }],
      },
    });
    expect(createRes.statusCode).toBe(201);
    const { webhook, token } = createRes.json();

    // Send Bamboo payload carrying HTTPS repositoryUrl matching SSH remote in repo-mobile.
    const res1 = await deliverBamboo(
      webhook.slug,
      token,
      bambooPayloadFor('MOB-IOS', {
        repositoryUrl: 'https://github.com/acme/mobile-app.git',
      }),
    );
    expect(res1.statusCode).toBe(202);
    expect(res1.json().status).toBe('filtered');
    expect(res1.json().reason).toContain('no mapping for MOB-IOS; suggested');
    expect(res1.json().reason).toContain('repo-mobile');

    const cached = readWebhookRouteCacheEntry(ctx.app.pocket.db, webhook.id, 'MOB-IOS');
    expect(cached).toMatchObject({
      cwd: repoMobile,
      source: 'git-history',
      confidence: 'unambiguous',
    });

    // Dismiss the suggestion.
    const dismissRes = await post(`/api/webhooks/${webhook.id}/routes/MOB-IOS/dismiss`);
    expect(dismissRes.statusCode).toBe(200);
    expect(dismissRes.json().entry.dismissedAt).toEqual(expect.any(Number));

    // Subsequent delivery for MOB-IOS no longer shows the dismissed suggestion.
    const res2 = await deliverBamboo(
      webhook.slug,
      token,
      bambooPayloadFor('MOB-IOS', {
        repositoryUrl: 'https://github.com/acme/mobile-app.git',
        buildResultKey: 'MOB-IOS-43',
      }),
    );
    expect(res2.statusCode).toBe(202);
    expect(res2.json().status).toBe('filtered');
    expect(res2.json().reason).not.toContain('suggested');
  });

  it('invalidates cached routes when a workspace folder is removed or its git remote changes', async () => {
    const externalParent = fs.mkdtempSync(path.join(path.dirname(ctx.workspaceRoot), 'pa170-ext-'));
    try {
      const extRepo = initRepo(externalParent, {
        remoteUrl: 'https://github.com/acme/ext-repo.git',
        commits: [
          { subject: '[EXT-1] First' },
          { subject: '[EXT-2] Second' },
          { subject: '[EXT-3] Third' },
          { subject: '[EXT-4] Fourth' },
        ],
      });

      const addWs = await post('/api/workspaces/add', { path: extRepo });
      expect(addWs.statusCode).toBe(200);

      const createRes = await post('/api/webhooks', {
        name: 'Invalidation Hook',
        slug: 'inv-hook',
        cwd: ctx.projectDir,
        agent: 'claude',
        autoRoute: 'auto',
        config: {
          type: 'jira',
          filter: {},
          projectMap: [{ projectKey: 'MAIN', cwd: ctx.projectDir }],
        },
      });
      const { webhook } = createRes.json();

      // Trigger Re-detect from the editor API.
      const detectRes = await post(`/api/webhooks/${webhook.id}/routes/detect`);
      expect(detectRes.statusCode).toBe(200);
      expect(detectRes.json().entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            routeKey: 'EXT',
            cwd: extRepo,
            source: 'git-history',
            confidence: 'unambiguous',
          }),
        ]),
      );

      // 1. Change git remote in extRepo -> reading the webhook invalidates the cached entry.
      git(extRepo, ['remote', 'set-url', 'origin', 'https://github.com/acme/completely-different.git']);
      const afterRemoteChange = await get(`/api/webhooks/${webhook.id}`);
      expect(afterRemoteChange.statusCode).toBe(200);
      expect(
        afterRemoteChange.json().routeCache.find((e: { routeKey: string }) => e.routeKey === 'EXT'),
      ).toBeUndefined();

      // Re-detect with the new remote.
      await post(`/api/webhooks/${webhook.id}/routes/detect`);
      expect(readWebhookRouteCache(ctx.app.pocket.db, webhook.id).some((r) => r.route_key === 'EXT')).toBe(
        true,
      );

      // 2. Remove extRepo from workspaces -> cached entry pointing at extRepo is invalidated.
      const remWs = await post('/api/workspaces/remove', { path: extRepo });
      expect(remWs.statusCode).toBe(200);

      const afterRemove = await get(`/api/webhooks/${webhook.id}`);
      expect(afterRemove.statusCode).toBe(200);
      expect(
        afterRemove.json().routeCache.find((e: { routeKey: string }) => e.routeKey === 'EXT'),
      ).toBeUndefined();
    } finally {
      fs.rmSync(externalParent, { recursive: true, force: true });
    }
  });

  it('respects precedence: explicit projectMap row wins over confirmed cache and autoRoute', async () => {
    const repoExplicit = initRepo(path.join(ctx.workspaceRoot, 'repo-explicit'), {
      commits: [{ subject: 'initial' }],
    });
    const repoHistory = initRepo(path.join(ctx.workspaceRoot, 'repo-history'), {
      commits: [
        { subject: '[WIN-1] Commit 1' },
        { subject: '[WIN-2] Commit 2' },
        { subject: '[WIN-3] Commit 3' },
        { subject: '[WIN-4] Commit 4' },
      ],
    });

    const createRes = await post('/api/webhooks', {
      name: 'Precedence Hook',
      slug: 'prec-hook',
      cwd: repoExplicit,
      agent: 'claude',
      worktreeMode: 'none',
      autoRoute: 'auto',
      config: {
        type: 'jira',
        filter: {},
        projectMap: [{ projectKey: 'OTH', cwd: repoExplicit }],
      },
    });
    const { webhook, secret } = createRes.json();

    // Detect so WIN -> repoHistory is in cache.
    await post(`/api/webhooks/${webhook.id}/routes/detect`);
    expect(readWebhookRouteCacheEntry(ctx.app.pocket.db, webhook.id, 'WIN')?.cwd).toBe(repoHistory);

    // Now add an explicit projectMap entry mapping WIN -> repoExplicit.
    const patchRes = await patch(`/api/webhooks/${webhook.id}`, {
      config: {
        type: 'jira',
        filter: {},
        projectMap: [
          { projectKey: 'OTH', cwd: repoExplicit },
          { projectKey: 'WIN', cwd: repoExplicit },
        ],
      },
    });
    expect(patchRes.statusCode).toBe(200);

    // Delivery for WIN-10 must use repoExplicit, NOT repoHistory, and without auto-routed reason.
    const delivRes = await deliverJira(webhook.slug, secret, jiraPayloadFor('WIN-10'));
    expect(delivRes.statusCode).toBe(202);
    expect(delivRes.json().status).toBe('running');
    expect(delivRes.json().reason).toBeNull();

    const deliveries = (await get(`/api/webhooks/${webhook.id}/deliveries`)).json().deliveries;
    expect(deliveries[0].cwd).toBe(repoExplicit);
  });
});

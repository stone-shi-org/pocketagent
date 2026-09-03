import { lazy } from 'react';

/**
 * Route-level code splitting for the pages a session doesn't need on first
 * paint. `App.tsx` and `DesktopShell.tsx` both render the full route table,
 * so importing these here once (instead of directly in each) keeps the
 * dynamic-import call sites — and therefore the emitted chunks — identical
 * between the phone and desktop layouts.
 *
 * Login/Projects/Composer/SessionRoute/ChatPreview stay eager: they're on
 * the path from "open the app" to "read or send a message", the app's core
 * loop. Settings, Agents fleet, and the cron/webhook admin screens are
 * reached from an overflow menu and are comparatively heavy (forms, editors,
 * history tables) — deferring them is what actually shrinks the bundle a
 * phone has to parse before it can show a chat.
 */
export const SettingsPage = lazy(() =>
  import('./pages/SettingsPage.js').then((m) => ({ default: m.SettingsPage })),
);

export const AgentsFleetPage = lazy(() =>
  import('./pages/AgentsFleetPage.js').then((m) => ({ default: m.AgentsFleetPage })),
);

export const CronJobsPage = lazy(() =>
  import('./pages/CronJobsPage.js').then((m) => ({ default: m.CronJobsPage })),
);

export const CronJobEditorPage = lazy(() =>
  import('./pages/CronJobEditorPage.js').then((m) => ({ default: m.CronJobEditorPage })),
);

export const WebhooksPage = lazy(() =>
  import('./pages/WebhooksPage.js').then((m) => ({ default: m.WebhooksPage })),
);

export const WebhookEditorPage = lazy(() =>
  import('./pages/WebhookEditorPage.js').then((m) => ({ default: m.WebhookEditorPage })),
);

import webpush from 'web-push';
import type { Db } from '../db/index.js';

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

interface SubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Web Push for pending approvals.
 *
 * This is the only part of PocketAgent that talks to the outside world: the
 * browser's push service (Mozilla's, Google's, Apple's) relays the message. The
 * payload is encrypted end-to-end with the subscription's own keys, so the relay
 * sees ciphertext — but the *fact* of a notification, and its timing, are
 * visible to it. Payloads therefore say "approval needed", never what the agent
 * wants to do or which file it touches.
 *
 * VAPID keys are generated once and stored in SQLite next to everything else,
 * so nothing extra needs configuring.
 */
export class PushService {
  private publicKey: string | null = null;
  private enabled = false;

  constructor(
    private readonly db: Db,
    private readonly logger?: { warn: (o: object, m?: string) => void; info: (o: object, m?: string) => void },
  ) {}

  init(contact: string): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS push_keys (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        public_key  TEXT NOT NULL,
        private_key TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint   TEXT PRIMARY KEY,
        p256dh     TEXT NOT NULL,
        auth       TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    let keys = this.db.prepare('SELECT public_key, private_key FROM push_keys WHERE id = 1').get() as
      | { public_key: string; private_key: string }
      | undefined;

    if (!keys) {
      const generated = webpush.generateVAPIDKeys();
      this.db
        .prepare(
          'INSERT INTO push_keys (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)',
        )
        .run(generated.publicKey, generated.privateKey, Date.now());
      keys = { public_key: generated.publicKey, private_key: generated.privateKey };
      this.logger?.info({}, 'generated VAPID keys for web push');
    }

    try {
      webpush.setVapidDetails(contact, keys.public_key, keys.private_key);
      this.publicKey = keys.public_key;
      this.enabled = true;
    } catch (err) {
      this.logger?.warn({ err }, 'web push disabled: invalid VAPID configuration');
      this.enabled = false;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getPublicKey(): string | null {
    return this.publicKey;
  }

  subscribe(subscription: unknown): boolean {
    const parsed = parseSubscription(subscription);
    if (!parsed) return false;
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
      )
      .run(parsed.endpoint, parsed.p256dh, parsed.auth, Date.now());
    return true;
  }

  unsubscribe(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM push_subscriptions').get() as {
      c: number;
    };
    return row.c;
  }

  /** Deliver to every subscription, pruning any the push service rejects. */
  async send(payload: PushPayload): Promise<{ sent: number; pruned: number }> {
    if (!this.enabled) return { sent: 0, pruned: 0 };

    const rows = this.db
      .prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions')
      .all() as SubscriptionRow[];
    if (rows.length === 0) return { sent: 0, pruned: 0 };

    let sent = 0;
    let pruned = 0;
    const body = JSON.stringify(payload);

    await Promise.all(
      rows.map(async (row) => {
        try {
          await webpush.sendNotification(
            { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
            body,
            { TTL: 600, urgency: 'high' },
          );
          sent++;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          // 404/410 mean the browser dropped the subscription for good.
          if (status === 404 || status === 410) {
            this.unsubscribe(row.endpoint);
            pruned++;
          } else {
            this.logger?.warn({ status }, 'push delivery failed');
          }
        }
      }),
    );

    return { sent, pruned };
  }
}

function parseSubscription(
  value: unknown,
): { endpoint: string; p256dh: string; auth: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const endpoint = record.endpoint;
  const keys = record.keys;
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) return null;
  if (typeof keys !== 'object' || keys === null) return null;
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  return { endpoint, p256dh, auth };
}

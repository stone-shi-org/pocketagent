import webpush from 'web-push';
import type { PushPayload } from '@pocketagent/protocol';
import type { HubDb } from '../db.js';

interface SubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * PA-73: Hub Web Push service.
 *
 * Owns the VAPID keypair for the Hub origin and stores browser push subscriptions.
 * Because the browser visits the Hub as a single origin, it registers one service
 * worker (/sw.js) and one push subscription using the Hub's VAPID key.
 *
 * When any bound backend emits an approval or turn-complete event, the Hub's
 * relay delivers the notification to every subscription stored here.
 */
export class HubPushService {
  private publicKey: string | null = null;
  private enabled = false;

  constructor(
    private readonly db: HubDb,
    private readonly logger?: { warn: (o: object, m?: string) => void; info: (o: object, m?: string) => void },
  ) {}

  init(contact: string): void {
    let keys = this.db
      .prepare('SELECT public_key, private_key FROM hub_push_keys WHERE id = 1')
      .get() as { public_key: string; private_key: string } | undefined;

    if (!keys) {
      const generated = webpush.generateVAPIDKeys();
      this.db
        .prepare(
          'INSERT INTO hub_push_keys (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)',
        )
        .run(generated.publicKey, generated.privateKey, Date.now());
      keys = { public_key: generated.publicKey, private_key: generated.privateKey };
      this.logger?.info({}, 'generated VAPID keys for hub web push');
    }

    try {
      webpush.setVapidDetails(contact, keys.public_key, keys.private_key);
      this.publicKey = keys.public_key;
      this.enabled = true;
    } catch (err) {
      this.logger?.warn({ err }, 'hub web push disabled: invalid VAPID configuration');
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
        `INSERT INTO hub_push_subscriptions (endpoint, p256dh, auth, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
      )
      .run(parsed.endpoint, parsed.p256dh, parsed.auth, Date.now());
    return true;
  }

  unsubscribe(endpoint: string): void {
    this.db.prepare('DELETE FROM hub_push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM hub_push_subscriptions').get() as {
      c: number;
    };
    return row.c;
  }

  /** Deliver to every browser subscription, pruning any the push service rejects. */
  async send(payload: PushPayload): Promise<{ sent: number; pruned: number }> {
    if (!this.enabled) return { sent: 0, pruned: 0 };

    const rows = this.db
      .prepare('SELECT endpoint, p256dh, auth FROM hub_push_subscriptions')
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

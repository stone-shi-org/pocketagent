import { z } from 'zod';

/**
 * PA-73: Shared push notification types and schemas.
 *
 * Web push is single-origin: under the Hub, the browser subscribes once to the Hub
 * origin. Bound backends stream notification events to the Hub, which rewrites
 * deep-link URLs to include the host ID and fans out push messages to the
 * browser's push subscription using the Hub's VAPID keypair.
 */

export const PushPayload = z.object({
  title: z.string(),
  body: z.string(),
  url: z.string(),
  tag: z.string().optional(),
});
export type PushPayload = z.infer<typeof PushPayload>;

export const PushKeyResponse = z.object({
  publicKey: z.string().nullable(),
});
export type PushKeyResponse = z.infer<typeof PushKeyResponse>;

export const HostPushStreamState = z.enum([
  'connected',
  'reconnecting',
  'unsupported',
  'unauthorized',
  'unbound',
  'disabled',
]);
export type HostPushStreamState = z.infer<typeof HostPushStreamState>;

export const HostPushStatus = z.object({
  ok: z.boolean(),
  status: HostPushStreamState,
  reason: z.string().optional(),
});
export type HostPushStatus = z.infer<typeof HostPushStatus>;

export const PushStatusResponse = z.object({
  enabled: z.boolean(),
  subscriptions: z.number().int().nonnegative(),
  /** Present on the Hub: connection status for each registered host's push stream. */
  hosts: z.record(HostPushStatus).optional(),
});
export type PushStatusResponse = z.infer<typeof PushStatusResponse>;

export const SubscribePushBody = z.object({
  subscription: z.record(z.unknown()),
});
export type SubscribePushBody = z.infer<typeof SubscribePushBody>;

export const UnsubscribePushBody = z.object({
  endpoint: z.string().min(1).max(2048),
});
export type UnsubscribePushBody = z.infer<typeof UnsubscribePushBody>;

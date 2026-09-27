import { createHash } from 'node:crypto';
import { RedisService, RedisClient } from './redis.service';
import { redis } from '../lib/redis';
import logger from '../utils/logger';

/** Delivered webhook hashes are retained for 24 hours. */
export const WEBHOOK_DELIVERY_TTL_SECONDS = 24 * 60 * 60;

export const WEBHOOK_DELIVERY_KEY_PREFIX = 'webhook:delivered:';

export interface WebhookDeliveryStore {
  hasBeenDelivered(hash: string): Promise<boolean>;
  markDelivered(hash: string, ttlSeconds?: number): Promise<void>;
}

/**
 * Builds a stable Idempotency-Key for a status-transition webhook.
 * Same transaction + transition always yields the same key so partners
 * can safely dedupe retries.
 */
export function buildIdempotencyKey(params: {
  protocol: string;
  transactionId: string;
  previousStatus: string;
  nextStatus: string;
}): string {
  const { protocol, transactionId, previousStatus, nextStatus } = params;
  return `${protocol}:${transactionId}:${previousStatus}->${nextStatus}`;
}

/**
 * SHA-256 hash of the canonical delivery identity (idempotency key + URL).
 * Used as the Redis key payload for 24h deduplication.
 */
export function buildWebhookDeliveryHash(params: {
  idempotencyKey: string;
  callbackUrl: string;
}): string {
  return createHash('sha256')
    .update(`${params.idempotencyKey}|${params.callbackUrl}`)
    .digest('hex');
}

export class RedisWebhookDeliveryStore implements WebhookDeliveryStore {
  private readonly redisService: RedisService;

  constructor(client: RedisClient = redis as unknown as RedisClient) {
    this.redisService = new RedisService(client);
  }

  private key(hash: string): string {
    return `${WEBHOOK_DELIVERY_KEY_PREFIX}${hash}`;
  }

  async hasBeenDelivered(hash: string): Promise<boolean> {
    try {
      const existing = await this.redisService.getJSON<{ deliveredAt: string }>(this.key(hash));
      return existing !== null;
    } catch (err) {
      logger.warn('Webhook delivery Redis read failed; allowing delivery attempt', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  async markDelivered(
    hash: string,
    ttlSeconds: number = WEBHOOK_DELIVERY_TTL_SECONDS
  ): Promise<void> {
    try {
      await this.redisService.setJSON(
        this.key(hash),
        { deliveredAt: new Date().toISOString() },
        ttlSeconds
      );
    } catch (err) {
      logger.warn('Webhook delivery Redis write failed after successful send', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export const defaultWebhookDeliveryStore = new RedisWebhookDeliveryStore();

/**
 * In-memory store for unit tests (and environments without Redis).
 */
export class InMemoryWebhookDeliveryStore implements WebhookDeliveryStore {
  private readonly entries = new Map<string, { expiresAt: number }>();

  async hasBeenDelivered(hash: string): Promise<boolean> {
    const entry = this.entries.get(hash);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(hash);
      return false;
    }
    return true;
  }

  async markDelivered(
    hash: string,
    ttlSeconds: number = WEBHOOK_DELIVERY_TTL_SECONDS
  ): Promise<void> {
    this.entries.set(hash, { expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  clear(): void {
    this.entries.clear();
  }
}

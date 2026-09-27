import {
  buildIdempotencyKey,
  buildWebhookDeliveryHash,
  InMemoryWebhookDeliveryStore,
  WEBHOOK_DELIVERY_TTL_SECONDS,
} from './idempotentWebhook.service';

describe('idempotentWebhook.service', () => {
  it('builds a stable Idempotency-Key for identical status transitions', () => {
    const a = buildIdempotencyKey({
      protocol: 'sep24',
      transactionId: 'tx-1',
      previousStatus: 'pending_user',
      nextStatus: 'completed',
    });
    const b = buildIdempotencyKey({
      protocol: 'sep24',
      transactionId: 'tx-1',
      previousStatus: 'pending_user',
      nextStatus: 'completed',
    });
    expect(a).toBe('sep24:tx-1:pending_user->completed');
    expect(a).toBe(b);
  });

  it('builds different keys for different transitions', () => {
    const a = buildIdempotencyKey({
      protocol: 'sep24',
      transactionId: 'tx-1',
      previousStatus: 'pending_user',
      nextStatus: 'pending_anchor',
    });
    const b = buildIdempotencyKey({
      protocol: 'sep24',
      transactionId: 'tx-1',
      previousStatus: 'pending_anchor',
      nextStatus: 'completed',
    });
    expect(a).not.toBe(b);
  });

  it('builds a deterministic delivery hash', () => {
    const hash1 = buildWebhookDeliveryHash({
      idempotencyKey: 'sep24:tx-1:a->b',
      callbackUrl: 'https://partner.example/hook',
    });
    const hash2 = buildWebhookDeliveryHash({
      idempotencyKey: 'sep24:tx-1:a->b',
      callbackUrl: 'https://partner.example/hook',
    });
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it('stores delivered hashes and prevents duplicates within TTL', async () => {
    const store = new InMemoryWebhookDeliveryStore();
    const hash = 'abc123';

    expect(await store.hasBeenDelivered(hash)).toBe(false);
    await store.markDelivered(hash, WEBHOOK_DELIVERY_TTL_SECONDS);
    expect(await store.hasBeenDelivered(hash)).toBe(true);
  });

  it('expires delivered hashes after TTL', async () => {
    jest.useFakeTimers();
    const store = new InMemoryWebhookDeliveryStore();
    const hash = 'ttl-hash';

    await store.markDelivered(hash, 1);
    expect(await store.hasBeenDelivered(hash)).toBe(true);

    jest.advanceTimersByTime(1001);
    expect(await store.hasBeenDelivered(hash)).toBe(false);
    jest.useRealTimers();
  });
});

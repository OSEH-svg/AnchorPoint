import { createCallbackNotifier } from './sep31CallbackNotifier';
import { InMemoryWebhookDeliveryStore } from './idempotentWebhook.service';
import type { Sep31Transaction } from './sep31.service';

jest.mock('./alert-email.service', () => ({
  alertEmailService: {
    sendSystemAlert: jest.fn().mockResolvedValue(undefined),
  },
}));

const baseTx: Sep31Transaction = {
  id: 'sep31-tx-1',
  status: 'completed',
  assetCode: 'USDC',
  amount: '25.00',
  senderInfo: {},
  receiverInfo: {},
  callbackUrl: 'https://partner.example/sep31',
  refunded: false,
  startedAt: '2026-07-30T10:00:00.000Z',
};

describe('sep31CallbackNotifier idempotent webhooks', () => {
  it('includes Idempotency-Key on successful callback', async () => {
    const httpClient = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const deliveryStore = new InMemoryWebhookDeliveryStore();
    const enqueueRetry = jest.fn();

    const notifier = createCallbackNotifier({
      httpClient,
      deliveryStore,
      enqueueRetry,
      resolvePreviousStatus: () => 'pending_sender',
    });

    await notifier.notify(baseTx);

    expect(httpClient).toHaveBeenCalledTimes(1);
    const [, request] = httpClient.mock.calls[0];
    expect(request.headers['Idempotency-Key']).toBe(
      'sep31:sep31-tx-1:pending_sender->completed'
    );
    expect(enqueueRetry).not.toHaveBeenCalled();
  });

  it('prevents duplicate callback emissions for identical transitions', async () => {
    const httpClient = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const deliveryStore = new InMemoryWebhookDeliveryStore();

    const notifier = createCallbackNotifier({
      httpClient,
      deliveryStore,
      enqueueRetry: jest.fn(),
      resolvePreviousStatus: () => 'pending_sender',
    });

    await notifier.notify(baseTx);
    await notifier.notify(baseTx);

    expect(httpClient).toHaveBeenCalledTimes(1);
  });

  it('enqueues retry queue when callback returns non-2xx', async () => {
    const httpClient = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    const enqueueRetry = jest.fn().mockResolvedValue('job-1');

    const notifier = createCallbackNotifier({
      httpClient,
      deliveryStore: new InMemoryWebhookDeliveryStore(),
      enqueueRetry,
      resolvePreviousStatus: () => 'pending_sender',
    });

    await notifier.notify(baseTx);

    expect(enqueueRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: 'sep31',
        transactionId: 'sep31-tx-1',
        idempotencyKey: 'sep31:sep31-tx-1:pending_sender->completed',
      })
    );
  });

  it('no-ops when callbackUrl is missing', async () => {
    const httpClient = jest.fn();
    const notifier = createCallbackNotifier({
      httpClient,
      deliveryStore: new InMemoryWebhookDeliveryStore(),
      enqueueRetry: jest.fn(),
    });

    await notifier.notify({ ...baseTx, callbackUrl: undefined });
    expect(httpClient).not.toHaveBeenCalled();
  });
});

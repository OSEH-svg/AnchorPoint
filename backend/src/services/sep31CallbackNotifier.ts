import logger from "../utils/logger";
import type { Sep31Transaction, CallbackNotifier } from "./sep31.service";
import { alertEmailService } from "./alert-email.service";
import {
  buildIdempotencyKey,
  buildWebhookDeliveryHash,
  defaultWebhookDeliveryStore,
  type WebhookDeliveryStore,
} from "./idempotentWebhook.service";
import { enqueueWebhookRetry } from "./webhookRetry.queue";

// ─── HTTP client abstraction (injectable for testing) ─────────────────────────

export type HttpClient = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number }>;

const defaultHttpClient: HttpClient = async (url, init) => {
  const response = await fetch(url, init);
  return { ok: response.ok, status: response.status };
};

export interface CallbackNotifierDependencies {
  httpClient?: HttpClient;
  deliveryStore?: WebhookDeliveryStore;
  enqueueRetry?: typeof enqueueWebhookRetry;
  /** Previous status used for idempotency when available (defaults to "unknown"). */
  resolvePreviousStatus?: (transaction: Sep31Transaction) => string;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a CallbackNotifier that fires an HTTP POST to the transaction's
 * callbackUrl with the full transaction JSON body.
 *
 * Idempotent delivery (SEP-24 / partner webhook requirements):
 *  - Unique `Idempotency-Key` header per status transition
 *  - Delivered webhook hashes stored in Redis with a 24-hour TTL
 *  - Duplicate emissions for identical status transitions are skipped
 *  - Failed deliveries are enqueued on the webhook-delivery retry queue
 *
 * Behaviour (per Requirements 6.1–6.3):
 *  - 5000 ms AbortController timeout
 *  - Non-2xx response → log failure, enqueue retry, resolve (no throw)
 *  - Timeout / network error → log failure, enqueue retry, resolve (no throw)
 */
export const createCallbackNotifier = (
  httpClientOrDeps: HttpClient | CallbackNotifierDependencies = defaultHttpClient,
): CallbackNotifier => {
  const deps: CallbackNotifierDependencies =
    typeof httpClientOrDeps === "function"
      ? { httpClient: httpClientOrDeps }
      : httpClientOrDeps;

  const httpClient = deps.httpClient ?? defaultHttpClient;
  const deliveryStore = deps.deliveryStore ?? defaultWebhookDeliveryStore;
  const enqueueRetry = deps.enqueueRetry ?? enqueueWebhookRetry;
  const resolvePreviousStatus =
    deps.resolvePreviousStatus ??
    ((tx: Sep31Transaction) => (tx as Sep31Transaction & { previousStatus?: string }).previousStatus ?? "unknown");

  return {
    async notify(transaction: Sep31Transaction): Promise<void> {
      // Trigger automated payment update notification dispatches (SEP-31)
      try {
        await alertEmailService.sendSystemAlert('admin@example.com', {
          severity: 'info',
          metric: 'sep31_status_change',
          message: `Transaction ${transaction.id} status changed to ${transaction.status}`,
          value: 1,
          threshold: 0,
          detectedAt: new Date().toISOString(),
        });
        logger.info(`Transactional email dispatched for SEP-31 status change: ${transaction.id}`);
      } catch (err) {
        logger.warn('Failed to dispatch transactional email', { error: err });
      }

      if (!transaction.callbackUrl) return;

      const previousStatus = resolvePreviousStatus(transaction);
      const nextStatus = String(transaction.status);
      const idempotencyKey = buildIdempotencyKey({
        protocol: "sep31",
        transactionId: transaction.id,
        previousStatus,
        nextStatus,
      });
      const deliveryHash = buildWebhookDeliveryHash({
        idempotencyKey,
        callbackUrl: transaction.callbackUrl,
      });

      if (await deliveryStore.hasBeenDelivered(deliveryHash)) {
        logger.info("Skipping duplicate SEP-31 callback (already delivered)", {
          transactionId: transaction.id,
          idempotencyKey,
        });
        return;
      }

      const body = JSON.stringify(transaction);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      try {
        const response = await httpClient(transaction.callbackUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          logger.warn("SEP-31 callback returned non-2xx response", {
            transactionId: transaction.id,
            url: transaction.callbackUrl,
            status: response.status,
            idempotencyKey,
          });
          await enqueueRetry({
            protocol: "sep31",
            transactionId: transaction.id,
            previousStatus,
            nextStatus,
            callbackUrl: transaction.callbackUrl,
            idempotencyKey,
            deliveryHash,
            payload: body,
            attempt: 1,
          });
          return;
        }

        await deliveryStore.markDelivered(deliveryHash);
        logger.info("SEP-31 callback delivered", {
          transactionId: transaction.id,
          idempotencyKey,
        });
      } catch (err: unknown) {
        clearTimeout(timeout);

        const isTimeout =
          err instanceof Error &&
          (err.name === "AbortError" || err.message.includes("abort"));

        logger.warn(
          isTimeout
            ? "SEP-31 callback timed out"
            : "SEP-31 callback network error",
          {
            transactionId: transaction.id,
            url: transaction.callbackUrl,
            error: err instanceof Error ? err.message : String(err),
            idempotencyKey,
          },
        );

        await enqueueRetry({
          protocol: "sep31",
          transactionId: transaction.id,
          previousStatus,
          nextStatus,
          callbackUrl: transaction.callbackUrl,
          idempotencyKey,
          deliveryHash,
          payload: body,
          attempt: 1,
        });
        // Resolve without throwing — retries happen via the webhook-delivery queue
      }
    },
  };
};

export default createCallbackNotifier;

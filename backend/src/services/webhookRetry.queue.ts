import { Queue, JobsOptions } from 'bullmq';
import { defaultQueueOptions, QUEUE_NAMES, JobPriority } from '../config/queue';
import logger from '../utils/logger';

export interface WebhookRetryJobData {
  protocol: string;
  transactionId: string;
  previousStatus: string;
  nextStatus: string;
  callbackUrl: string;
  idempotencyKey: string;
  deliveryHash: string;
  payload: string;
  attempt: number;
}

const WEBHOOK_RETRY_JOB_OPTIONS: Partial<JobsOptions> = {
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 2000,
  },
  priority: JobPriority.NORMAL,
  removeOnComplete: {
    age: 24 * 3600,
    count: 1000,
  },
  removeOnFail: {
    age: 7 * 24 * 3600,
  },
};

let webhookRetryQueue: Queue<WebhookRetryJobData> | null = null;

function getWebhookRetryQueue(): Queue<WebhookRetryJobData> {
  if (!webhookRetryQueue) {
    webhookRetryQueue = new Queue<WebhookRetryJobData>(QUEUE_NAMES.WEBHOOK_DELIVERY, defaultQueueOptions);
  }
  return webhookRetryQueue;
}

/**
 * Enqueues a failed webhook for asynchronous retry via BullMQ.
 * Failures to enqueue are logged and swallowed so callers are never blocked.
 */
export async function enqueueWebhookRetry(data: WebhookRetryJobData): Promise<string | null> {
  try {
    const queue = getWebhookRetryQueue();
    const job = await queue.add('webhook-retry', data, {
      ...WEBHOOK_RETRY_JOB_OPTIONS,
      jobId: `webhook-${data.deliveryHash}`,
    });
    logger.info('Enqueued webhook retry job', {
      jobId: job.id,
      transactionId: data.transactionId,
      protocol: data.protocol,
      idempotencyKey: data.idempotencyKey,
    });
    return job.id ?? null;
  } catch (err) {
    logger.warn('Failed to enqueue webhook retry job', {
      transactionId: data.transactionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Test helper to inject / reset the queue instance. */
export function setWebhookRetryQueueForTests(queue: Queue<WebhookRetryJobData> | null): void {
  webhookRetryQueue = queue;
}

export { WEBHOOK_RETRY_JOB_OPTIONS };

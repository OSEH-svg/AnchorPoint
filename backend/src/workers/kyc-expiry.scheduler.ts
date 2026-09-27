import cron, { ScheduledTask } from 'node-cron';
import { processKycExpirationGracePeriod } from '../services/kyc.service';
import logger from '../utils/logger';

export class KycExpiryScheduler {
  private task: ScheduledTask | null = null;

  start(): void {
    this.task = cron.schedule('0 0 * * *', async () => {
      try {
        const processedCount = await processKycExpirationGracePeriod(7);
        if (processedCount > 0) {
          logger.info(`Processed KYC expiration grace period for ${processedCount} customers`);
        }
      } catch (error) {
        logger.error('Failed to run KYC expiry grace period task', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    logger.info('KYC expiry grace period scheduler started (running daily at midnight)');
  }

  stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }
    logger.info('KYC expiry grace period scheduler stopped');
  }
}

export const kycExpiryScheduler = new KycExpiryScheduler();

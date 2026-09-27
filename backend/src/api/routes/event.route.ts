import { Router } from 'express';
import { eventController } from '../controllers/event.controller';
import { webhookSignatureMiddleware } from '../middleware/auth.middleware';
import logger from '../../utils/logger';

const router = Router();

/**
 * @swagger
 * /api/events:
 *   get:
 *     summary: Retrieve indexed Soroban contract events
 *     tags: [Events]
 *     parameters:
 *       - in: query
 *         name: contractId
 *         schema:
 *           type: string
 *         description: Filter by contract ID
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *         description: Filter by event type (e.g., contract)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Number of records to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *         description: Number of records to skip
 *     responses:
 *       200:
 *         description: List of events
 *       500:
 *         description: Server error
 */
router.get('/', eventController.getEvents);

/**
 * @swagger
 * /api/events/health:
 *   get:
 *     summary: Get event indexer health status
 *     description: Returns the current health of the event indexer, including last synced block and gap to ledger tip
 *     tags: [Events]
 *     responses:
 *       200:
 *         description: Health status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     lastSyncedBlock:
 *                       type: number
 *                       description: The last block number synced to the database
 *                     ledgerTip:
 *                       type: number
 *                       description: The current ledger tip from the blockchain
 *                     gap:
 *                       type: number
 *                       description: The gap between local DB and ledger tip
 *                     isHealthy:
 *                       type: boolean
 *                       description: Whether the indexer is considered healthy (gap < 1000 blocks)
 *                     timestamp:
 *                       type: string
 *                       format: date-time
 *       500:
 *         description: Server error
 */
router.get('/health', eventController.getHealth);

router.post('/webhook', webhookSignatureMiddleware, async (req, res) => {
  try {
    logger.info('Received webhook callback', { body: req.body });
    res.status(200).json({ received: true });
  } catch (error) {
    logger.error('Webhook processing failed', { error: error instanceof Error ? error.message : 'Unknown error' });
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

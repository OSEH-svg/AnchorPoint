import { Router } from 'express';
import { getConfig, getUiConfig, getHistory, updateConfig, updateUiConfig, rollbackConfig, getAuditLogs } from '../controllers/config.controller';

const router = Router();

/**
 * @swagger
 * /config:
 *   get:
 *     summary: Get active configuration
 *     description: Retrieves the current active dynamic configuration for the backend. Requires an API key with appropriate permissions (usually admin tier, but for now uses general API Key auth).
 *     tags: [Configuration]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Active configuration retrieved
 *       401:
 *         description: Unauthorized
 */
router.get('/', getConfig);
router.get('/ui', getUiConfig);

/**
 * @swagger
 * /config/history:
 *   get:
 *     summary: Get configuration history
 *     description: Retrieves past configuration versions (up to 20).
 *     tags: [Configuration]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Configuration history retrieved
 *       401:
 *         description: Unauthorized
 */
router.get('/history', getHistory);

/**
 * @swagger
 * /config/audit-logs:
 *   get:
 *     summary: Get configuration audit logs
 *     description: Retrieves the immutable admin audit trail for system configuration changes (updates, UI updates, and rollbacks).
 *     tags: [Configuration]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: action
 *         schema:
 *           type: string
 *           enum: [CONFIG_UPDATE, CONFIG_UI_UPDATE, CONFIG_ROLLBACK]
 *         description: Filter by audit action
 *       - in: query
 *         name: actorId
 *         schema:
 *           type: string
 *         description: Filter by the acting administrator id
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 200
 *           default: 50
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *     responses:
 *       200:
 *         description: Audit logs retrieved
 *       401:
 *         description: Unauthorized
 */
router.get('/audit-logs', getAuditLogs);

/**
 * @swagger
 * /config:
 *   post:
 *     summary: Update configuration
 *     description: Updates the dynamic configuration, bumping the version and broadcasting the change to other instances.
 *     tags: [Configuration]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: The new configuration settings (must pass validation)
 *     responses:
 *       200:
 *         description: Configuration updated successfully
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 */
router.post('/', updateConfig);
router.post('/ui', updateUiConfig);

/**
 * @swagger
 * /config/rollback/{version}:
 *   post:
 *     summary: Rollback configuration
 *     description: Reverts the configuration to a specific previous version.
 *     tags: [Configuration]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: version
 *         schema:
 *           type: integer
 *         required: true
 *         description: The version number to rollback to
 *     responses:
 *       200:
 *         description: Rolled back successfully
 *       400:
 *         description: Invalid version number
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Version not found
 */
router.post('/rollback/:version', rollbackConfig);

export default router;

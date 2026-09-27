import { Request, Response } from 'express';
import configService from '../../services/config.service';
import adminAuditService, { AdminAuditAction, AuditActor } from '../../services/admin-audit.service';
import logger from '../../utils/logger';

/**
 * Derives the acting administrator from the request. Falls back gracefully
 * when the request has not been augmented with an authenticated identity.
 */
function getActor(req: Request): AuditActor {
  const authed = req as Request & {
    admin?: { id?: string; email?: string };
    user?: { id?: string; email?: string };
    apiKey?: { id?: string; label?: string };
  };

  const identity = authed.admin ?? authed.user;
  const forwardedFor = req.headers['x-forwarded-for'];
  const ip = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor?.split(',')[0]?.trim() || req.ip;

  return {
    id: identity?.id ?? authed.apiKey?.id ?? null,
    email: identity?.email ?? authed.apiKey?.label ?? null,
    ip: ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  };
}

export const getConfig = async (req: Request, res: Response) => {
  try {
    const config = configService.getConfig();
    // In a real application, you might want to obscure secrets in this response
    // But since it's an admin-only endpoint, we can return the whole config
    res.json({
      status: 'success',
      data: config
    });
  } catch (error) {
    logger.error('Error fetching config:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch configuration' });
  }
};

export const getUiConfig = async (req: Request, res: Response) => {
  try {
    const config = configService.getUiConfig();
    res.json({
      status: 'success',
      data: config
    });
  } catch (error) {
    logger.error('Error fetching UI config:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch UI configuration' });
  }
};

export const getHistory = async (req: Request, res: Response) => {
  try {
    const history = await configService.getHistory();
    res.json({
      status: 'success',
      data: history
    });
  } catch (error) {
    logger.error('Error fetching config history:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch configuration history' });
  }
};

export const updateConfig = async (req: Request, res: Response) => {
  try {
    const newConfig = req.body;
    const result = await configService.updateConfig(newConfig, getActor(req));
    res.json({
      status: 'success',
      message: 'Configuration updated successfully',
      data: result
    });
  } catch (error) {
    logger.error('Error updating config:', error);
    if (error instanceof Error && error.name === 'ZodError') {
      res.status(400).json({ status: 'error', message: 'Validation failed', errors: JSON.parse(error.message) });
    } else {
      res.status(500).json({ status: 'error', message: 'Failed to update configuration' });
    }
  }
};

export const updateUiConfig = async (req: Request, res: Response) => {
  try {
    const result = await configService.updateUiConfig(req.body, getActor(req));
    res.json({
      status: 'success',
      message: 'UI configuration updated successfully',
      data: {
        version: result.version,
        ui: configService.getUiConfig(),
      }
    });
  } catch (error) {
    logger.error('Error updating UI config:', error);
    if (error instanceof Error && error.name === 'ZodError') {
      res.status(400).json({ status: 'error', message: 'Validation failed', errors: JSON.parse(error.message) });
    } else {
      res.status(500).json({ status: 'error', message: 'Failed to update UI configuration' });
    }
  }
};

export const rollbackConfig = async (req: Request, res: Response) => {
  try {
    const version = parseInt(req.params.version, 10);
    if (isNaN(version)) {
      return res.status(400).json({ status: 'error', message: 'Invalid version number' });
    }

    const result = await configService.rollbackToVersion(version, getActor(req));
    res.json({
      status: 'success',
      message: `Configuration rolled back to version ${version}`,
      data: result
    });
  } catch (error) {
    logger.error('Error rolling back config:', error);
    res.status(500).json({ status: 'error', message: error instanceof Error ? error.message : 'Failed to rollback configuration' });
  }
};

const AUDIT_ACTIONS: AdminAuditAction[] = ['CONFIG_UPDATE', 'CONFIG_UI_UPDATE', 'CONFIG_ROLLBACK'];

export const getAuditLogs = async (req: Request, res: Response) => {
  try {
    const actionParam = typeof req.query.action === 'string' ? req.query.action : undefined;
    const action =
      actionParam && AUDIT_ACTIONS.includes(actionParam as AdminAuditAction)
        ? (actionParam as AdminAuditAction)
        : undefined;

    const actorId = typeof req.query.actorId === 'string' ? req.query.actorId : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;

    const result = await adminAuditService.listAuditLogs({
      action,
      actorId,
      limit: Number.isNaN(limit as number) ? undefined : limit,
      offset: Number.isNaN(offset as number) ? undefined : offset,
    });

    res.json({
      status: 'success',
      data: result.entries,
      pagination: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      },
    });
  } catch (error) {
    logger.error('Error fetching config audit logs:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch configuration audit logs' });
  }
};

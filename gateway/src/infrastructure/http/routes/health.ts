import { Router, Request, Response } from 'express';
import { getDatabase } from '../../database/connection.js';
import { getRedis } from '../../redis/connection.js';

export const healthRouter = Router();

/**
 * GET /api/v1/admin/health
 * Deep health check — verifies DB and Redis connectivity.
 */
healthRouter.get('/health', async (_req: Request, res: Response) => {
  const startTime = process.uptime();
  const components: Record<string, { status: string; latencyMs?: number }> = {};

  // Check PostgreSQL
  try {
    const dbStart = Date.now();
    const db = getDatabase();
    await db.raw('SELECT 1');
    components.database = { status: 'up', latencyMs: Date.now() - dbStart };
  } catch {
    components.database = { status: 'down' };
  }

  // Check Redis
  try {
    const redisStart = Date.now();
    const redis = getRedis();
    await redis.ping();
    components.redis = { status: 'up', latencyMs: Date.now() - redisStart };
  } catch {
    components.redis = { status: 'down' };
  }

  const allUp = Object.values(components).every((c) => c.status === 'up');
  const status = allUp ? 'healthy' : 'degraded';
  const statusCode = allUp ? 200 : 503;

  res.status(statusCode).json({
    status,
    uptime: Math.floor(startTime),
    components,
  });
});

/**
 * GET /api/v1/admin/ping
 * Lightweight liveness probe — no external dependency checks.
 */
healthRouter.get('/ping', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

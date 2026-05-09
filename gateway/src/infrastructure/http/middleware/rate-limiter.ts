import { Request, Response, NextFunction } from 'express';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { getRedis } from '../../redis/connection.js';
import { RateLimitError } from '../../../domain/errors/index.js';
import { loadConfig } from '../../../config/index.js';

const config = loadConfig();

let ipRateLimiter: RateLimiterRedis | null = null;
let userRateLimiter: RateLimiterRedis | null = null;

function getLimiter(type: 'ip' | 'user') {
  const redisClient = getRedis();

  if (type === 'ip') {
    if (!ipRateLimiter) {
      ipRateLimiter = new RateLimiterRedis({
        storeClient: redisClient,
        keyPrefix: 'draftly:rl:ip',
        points: config.RATE_LIMIT_IP_PER_MIN, // Number of requests
        duration: 60, // Per 60 seconds
      });
    }
    return ipRateLimiter;
  } else {
    if (!userRateLimiter) {
      userRateLimiter = new RateLimiterRedis({
        storeClient: redisClient,
        keyPrefix: 'draftly:rl:user',
        points: config.RATE_LIMIT_USER_PER_MIN,
        duration: 60,
      });
    }
    return userRateLimiter;
  }
}

/** Rate limits by IP address (applied globally to untrusted endpoints) */
export async function ipRateLimitMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  try {
    const limiter = getLimiter('ip');
    const result = await limiter.consume(ip);
    res.set('X-RateLimit-Limit', String(limiter.points));
    res.set('X-RateLimit-Remaining', String(result.remainingPoints));
    next();
  } catch (rejection: any) {
    res.set('Retry-After', String(Math.round(rejection.msBeforeNext / 1000) || 1));
    next(new RateLimitError(Math.round(rejection.msBeforeNext / 1000) || 1));
  }
}

/** Rate limits by authenticated User ID (applied to internal API endpoints after auth) */
export async function userRateLimitMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = (req as any).user?.id;
  if (!userId) {
    // Fall back to IP if somehow not authenticated yet
    return ipRateLimitMiddleware(req, res, next);
  }

  try {
    const limiter = getLimiter('user');
    const result = await limiter.consume(userId);
    res.set('X-RateLimit-Limit', String(limiter.points));
    res.set('X-RateLimit-Remaining', String(result.remainingPoints));
    next();
  } catch (rejection: any) {
    res.set('Retry-After', String(Math.round(rejection.msBeforeNext / 1000) || 1));
    next(new RateLimitError(Math.round(rejection.msBeforeNext / 1000) || 1));
  }
}

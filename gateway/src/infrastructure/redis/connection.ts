import { Redis } from 'ioredis';
import { logger } from '../../shared/logger.js';

let _redis: Redis | null = null;

export function createRedis(url: string): Redis {
  if (_redis) return _redis;

  _redis = new Redis(url, {
    maxRetriesPerRequest: 3,
    family: 4,
    connectTimeout: 10000,
    keepAlive: 30000,
    retryStrategy(times: number) {
      if (times > 5) {
        logger.error({ times }, 'Redis: max reconnection attempts reached');
        return null; // Stop retrying
      }
      const delay = Math.min(times * 200, 3000);
      logger.warn({ times, delay }, 'Redis: reconnecting');
      return delay;
    },
    lazyConnect: false,
  });

  _redis.on('connect', () => logger.info('Redis connected'));
  _redis.on('error', (err: Error) => logger.error({ err }, 'Redis connection error'));

  return _redis;
}

export function getRedis(): Redis {
  if (!_redis) throw new Error('Redis not initialized. Call createRedis() first.');
  return _redis;
}

export async function destroyRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}

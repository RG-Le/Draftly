import { Request, Response, NextFunction } from 'express';
import { logger } from '../../../shared/logger.js';
import { getCorrelationId } from './correlation.js';

/**
 * Logs every request with correlation ID, method, path, and response time.
 * PII is never logged — see logger redact config.
 */
export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const correlationId = getCorrelationId(req);

  res.on('finish', () => {
    const duration = Date.now() - start;
    const logData = {
      correlationId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      responseTime: duration,
      userAgent: req.get('User-Agent'),
      userId: (req as any).userId || undefined,
    };

    if (res.statusCode >= 500) {
      logger.error(logData, 'request.completed');
    } else if (res.statusCode >= 400) {
      logger.warn(logData, 'request.completed');
    } else {
      logger.info(logData, 'request.completed');
    }
  });

  next();
}

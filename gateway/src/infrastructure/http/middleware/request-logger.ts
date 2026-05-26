import { Request, Response, NextFunction } from 'express';
import { logger } from '../../../shared/logger.js';
import { getCorrelationId } from './correlation.js';

export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const correlationId = getCorrelationId(req);

  // Log on arrival — before auth runs so userId won't be set yet
  logger.debug(
    { correlationId, method: req.method, url: req.originalUrl },
    'request.received',
  );

  res.on('finish', () => {
    const duration = Date.now() - start;
    const logData = {
      correlationId,
      method: req.method,
      path: req.path,
      url: req.originalUrl,
      statusCode: res.statusCode,
      responseTimeMs: duration,
      userId: (req as any).userId || (req as any).user?.id || undefined,
      ip: req.ip,
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

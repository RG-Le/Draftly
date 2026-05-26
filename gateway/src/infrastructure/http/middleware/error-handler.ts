import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../../domain/errors/index.js';
import { logger } from '../../../shared/logger.js';
import { getCorrelationId } from './correlation.js';

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const correlationId = getCorrelationId(req);
  const userId = (req as any).userId || (req as any).user?.id;
  const context = { correlationId, userId, method: req.method, path: req.path };

  if (err instanceof AppError && err.isOperational) {
    logger.warn(
      { ...context, code: err.code, statusCode: err.statusCode, message: err.message, details: err.details },
      'operational.error',
    );

    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  // Unexpected — log full stack trace with origin
  logger.error(
    {
      ...context,
      err: {
        message: err.message,
        name: err.name,
        stack: err.stack,
      },
    },
    'unhandled.error',
  );

  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
  });
}

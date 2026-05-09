import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../../domain/errors/index.js';
import { logger } from '../../../shared/logger.js';
import { getCorrelationId } from './correlation.js';

/**
 * Global error handler. Catches all errors and returns structured JSON responses.
 * - AppError (operational): return error details to client
 * - Unknown errors: log full stack, return generic 500
 */
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const correlationId = getCorrelationId(req);

  if (err instanceof AppError && err.isOperational) {
    // Operational error — safe to expose to client
    logger.warn(
      { correlationId, code: err.code, statusCode: err.statusCode, message: err.message },
      'operational.error',
    );

    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }

  // Unexpected error — log full stack, return generic message
  logger.error(
    { correlationId, err, stack: err.stack },
    'unhandled.error',
  );

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}

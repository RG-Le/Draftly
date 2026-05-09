import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Generates or propagates a correlation ID for cross-service tracing.
 * If the incoming request has X-Correlation-ID, we reuse it.
 * Otherwise, we generate a new UUID v4.
 */
export function correlationMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const existing = req.headers[CORRELATION_HEADER] as string | undefined;
  const correlationId = existing || uuidv4();

  // Attach to request for downstream use
  (req as any).correlationId = correlationId;

  // Set response header so clients can trace requests
  _res.setHeader(CORRELATION_HEADER, correlationId);

  next();
}

/** Extract correlation ID from request */
export function getCorrelationId(req: Request): string {
  return (req as any).correlationId || 'unknown';
}

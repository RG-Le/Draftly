import { Request, Response, NextFunction } from 'express';
import { AuthenticationError } from '../../../domain/errors/index.js';
import { TokenService } from '../../../domain/auth/token.service.js';
import { loadConfig, loadJwtKeys } from '../../../config/index.js';

// Setup token service instance for the middleware
const config = loadConfig();
// We grab keys from the global scope set in the entrypoint or fall back to filesystem.
const keys = (globalThis as any).__jwtKeys || loadJwtKeys(config);
const tokenService = new TokenService(config, keys);

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AuthenticationError('Missing or invalid Authorization header');
  }

  const token = authHeader.split(' ')[1];

  try {
    const payload = tokenService.verifyToken(token, 'access');
    // Attach user context to request
    (req as any).user = { id: payload.sub, email: payload.email, role: payload.role };
    // Maintain for request logger compat
    (req as any).userId = payload.sub;
    next();
  } catch (err) {
    // Propagate the specific AuthenticationError (expired, invalid signature, etc.)
    next(err);
  }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  const user = (req as any).user;
  if (!user || user.role !== 'admin') {
    throw new AuthenticationError('Admin access required');
  }
  next();
}

import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { EnvConfig } from '../../config/index.js';
import { TokenService } from '../../domain/auth/token.service.js';
import { getDatabase } from '../database/connection.js';
import { UserRepository } from '../../domain/users/repository.js';
import { logger } from '../../shared/logger.js';

let _io: Server | null = null;
const userSockets = new Map<string, Set<string>>(); // userId -> Set of socketIds

export function initWebSocket(httpServer: HttpServer, config: EnvConfig): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: config.CORS_ORIGINS.split(',').map(o => o.trim()),
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  // Auth Middleware
  io.use(async (socket: Socket, next) => {
    const log = logger.child({ 
      socketId: socket.id, 
      origin: socket.handshake.headers.origin,
      auth: socket.handshake.auth
    });

    try {
      const token = socket.handshake.auth.token || socket.handshake.headers['authorization']?.replace('Bearer ', '');
      if (!token) {
        log.warn('Socket handshake rejected: Token missing');
        return next(new Error('Authentication error: Token missing'));
      }

      // Keys should be loaded by this point in app startup
      const keys = (globalThis as any).__jwtKeys;
      if (!keys) {
        log.error('Socket handshake rejected: JWT keys not loaded in global state');
        return next(new Error('Authentication error: Keys missing'));
      }

      const tokenService = new TokenService(config, keys);
      const decoded = await tokenService.verifyToken(token, 'access');

      const db = getDatabase();
      const repo = new UserRepository(db);
      const user = await repo.findById(decoded.sub);

      if (!user || !user.isActive) {
        log.warn({ sub: decoded.sub }, 'Socket handshake rejected: User not found or inactive');
        return next(new Error('Authentication error: Invalid user'));
      }

      socket.data.userId = user.id;
      log.info({ userId: user.id }, 'Socket handshake successful');
      next();
    } catch (err: any) {
      log.warn({ error: err.message }, 'Socket handshake rejected: Verification failed');
      next(new Error(`Authentication error: ${err.message}`));
    }
  });

  io.on('connection', (socket: Socket) => {
    const userId = socket.data.userId;
    logger.info({ userId, socketId: socket.id }, 'WebSocket client connected');

    if (!userSockets.has(userId)) {
      userSockets.set(userId, new Set());
    }
    userSockets.get(userId)!.add(socket.id);

    // Join a personal room
    socket.join(`user:${userId}`);

    socket.on('disconnect', () => {
      logger.info({ userId, socketId: socket.id }, 'WebSocket client disconnected');
      const sockets = userSockets.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          userSockets.delete(userId);
        }
      }
    });
  });

  _io = io;
  return io;
}

export function getWebSocket(): Server {
  if (!_io) {
    throw new Error('WebSocket server not initialized');
  }
  return _io;
}

/**
 * Emit an event to a specific user across all their connected sessions.
 */
export function emitToUser(userId: string, event: string, data: any) {
  if (_io) {
    _io.to(`user:${userId}`).emit(event, data);
    logger.debug({ userId, event }, 'Emitted WebSocket event to user');
  }
}

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import { correlationMiddleware, requestLoggerMiddleware, errorHandler } from './middleware/index.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { connectionsRouter } from './routes/connections.js';
import { inboxRouter } from './routes/inbox.js';
import { historyRouter } from './routes/history.js';
import { profileRouter } from './routes/profile.js';
import { preferencesRouter } from './routes/preferences.js';
import { usageRouter } from './routes/usage.js';
import { configurePassport } from '../auth/google-strategy.js';
import { EnvConfig } from '../../config/index.js';
import passport from 'passport';

export function createApp(_config: EnvConfig): express.Application {
  configurePassport();
  const app = express();

  // --- Middleware stack (order matters) ---

  // 1. Correlation ID: generate/propagate trace ID
  app.use(correlationMiddleware);

  // 2. Request logging: log every request with correlation ID
  app.use(requestLoggerMiddleware);

  // 3. Security headers
  app.use(helmet());

  // 4. CORS whitelist
  app.use(
    cors({
      origin: function (_origin, callback) {
        // Temporarily allow all origins for UI development
        callback(null, true);
      },
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-ID', 'Accept'],
      credentials: true,
      maxAge: 86400,
    }),
  );

  // 5. Body parsing with size limit
  app.use(express.json({ limit: '1mb' }));

  // 6. Passport init
  app.use(passport.initialize());

  // --- Routes ---
  app.use('/api/v1/admin', healthRouter);
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/connections', connectionsRouter);
  app.use('/api/v1/inbox', inboxRouter);
  app.use('/api/v1/profile', profileRouter);
  app.use('/api/v1/history', historyRouter);
  app.use('/api/v1/preferences', preferencesRouter);
  app.use('/api/v1/usage', usageRouter);

  // --- Global error handler (must be last) ---
  app.use(errorHandler);

  return app;
}

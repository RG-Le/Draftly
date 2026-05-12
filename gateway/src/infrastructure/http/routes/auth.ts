import { Router, Request, Response } from 'express';
import passport from 'passport';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { getDatabase } from '../../database/connection.js';
import { UserRepository } from '../../../domain/users/repository.js';
import { TokenService } from '../../../domain/auth/token.service.js';
import { loadConfig, loadJwtKeys } from '../../../config/index.js';
import { ValidationError, AuthenticationError } from '../../../domain/errors/index.js';
import { requireAuth } from '../middleware/auth.js';
import { ipRateLimitMiddleware, userRateLimitMiddleware } from '../middleware/rate-limiter.js';
import { User } from '../../../domain/entities/index.js';

export const authRouter = Router();

const config = loadConfig();
const keys = (globalThis as any).__jwtKeys || loadJwtKeys(config);
const tokenService = new TokenService(config, keys);
const allowedFrontendOrigins = config.CORS_ORIGINS.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

function getSafeRedirectUri(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0) return null;

  try {
    const parsed = new URL(input);
    const isAllowed = allowedFrontendOrigins.some((origin) => origin === parsed.origin);
    return isAllowed ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function parseOAuthState(stateRaw: unknown): { redirectUri: string | null } {
  if (typeof stateRaw !== 'string' || stateRaw.length === 0) {
    return { redirectUri: null };
  }

  try {
    const parsed = JSON.parse(stateRaw) as { redirectUri?: unknown };
    return { redirectUri: getSafeRedirectUri(parsed.redirectUri) };
  } catch {
    return { redirectUri: null };
  }
}

// ============================================================================
// Google OAuth Flow (PKCE incremental consent)
// ============================================================================

// Step 1: Initiate Google Login (Profile/Email only)
authRouter.get(
  '/google',
  ipRateLimitMiddleware,
  (req: Request, res: Response, next) => {
    const redirectUri = getSafeRedirectUri(req.query.redirect_uri);
    const state = JSON.stringify({ redirectUri });

    passport.authenticate('google', {
      scope: ['profile', 'email'],
      prompt: 'select_account',
      session: false,
      state,
    })(req, res, next);
  },
);

// Google Callback
authRouter.get(
  '/google/callback',
  ipRateLimitMiddleware,
  passport.authenticate('google', { session: false, failureRedirect: '/login?error=auth_failed' }),
  async (req: Request, res: Response) => {
    // Passport attaches the authenticated user to `req.user`
    const user = req.user as User;
    const state = parseOAuthState(req.query.state);

    // Issue JWTs
    const accessToken = tokenService.generateAccessToken(user);
    const refreshToken = await tokenService.generateRefreshToken(user);

    if (state.redirectUri) {
      // Deliver tokens via URL fragment (#) — fragments are NOT sent to servers,
      // do NOT appear in access logs or Referer headers, and are NOT captured
      // by logging proxies. This prevents refresh token leakage (Vuln 3 fix).
      const redirectUrl = new URL(state.redirectUri);
      redirectUrl.hash = `accessToken=${encodeURIComponent(accessToken)}&refreshToken=${encodeURIComponent(refreshToken)}`;
      res.redirect(302, redirectUrl.toString());
      return;
    }

    // Fallback for local/manual testing when redirect_uri is not provided.
    res.json({
      message: 'Google login successful',
      user: { id: user.id, email: user.email, name: user.name },
      accessToken,
      refreshToken,
    });
  },
);

// ============================================================================
// Local Auth Flow (For Postman Testing)
// ============================================================================

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(100),
  password: z.string().min(8).max(100),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

authRouter.post('/register', ipRateLimitMiddleware, async (req: Request, res: Response) => {
  const result = registerSchema.safeParse(req.body);
  if (!result.success) throw new ValidationError('Invalid registration input', result.error.format());

  const { email, name, password } = result.data;
  const db = getDatabase();
  const repo = new UserRepository(db);

  const existing = await repo.findByEmail(email);
  if (existing) {
    throw new ValidationError('Email already in use');
  }

  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(password, salt);

  const user = await repo.create({
    email,
    name,
    passwordHash,
    authProvider: 'local',
    googleSub: null,
    role: 'user',
    isActive: true,
  });

  const accessToken = tokenService.generateAccessToken(user);
  const refreshToken = await tokenService.generateRefreshToken(user);

  res.status(201).json({
    message: 'Registration successful',
    user: { id: user.id, email: user.email, name: user.name },
    accessToken,
    refreshToken,
  });
});

authRouter.post('/login', ipRateLimitMiddleware, async (req: Request, res: Response) => {
  const result = loginSchema.safeParse(req.body);
  if (!result.success) throw new ValidationError('Invalid login input', result.error.format());

  const { email, password } = result.data;
  const db = getDatabase();
  const repo = new UserRepository(db);

  const user = await repo.findByEmail(email);
  if (!user || user.authProvider !== 'local' || !user.passwordHash) {
    throw new AuthenticationError('Invalid email or password');
  }

  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) {
    throw new AuthenticationError('Invalid email or password');
  }

  const accessToken = tokenService.generateAccessToken(user);
  const refreshToken = await tokenService.generateRefreshToken(user);

  res.json({
    message: 'Login successful',
    user: { id: user.id, email: user.email, name: user.name },
    accessToken,
    refreshToken,
  });
});

// ============================================================================
// Session Management
// ============================================================================

authRouter.post('/refresh', ipRateLimitMiddleware, async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  if (!refreshToken) throw new ValidationError('Refresh token is required');

  // Verify and consume the old refresh token (strict rotation)
  const decoded = await tokenService.consumeRefreshToken(refreshToken);

  const db = getDatabase();
  const repo = new UserRepository(db);
  const user = await repo.findById(decoded.sub);

  if (!user || !user.isActive) {
    throw new AuthenticationError('User not found or deactivated');
  }

  // Issue new tokens
  const newAccessToken = tokenService.generateAccessToken(user);
  const newRefreshToken = await tokenService.generateRefreshToken(user);

  res.json({
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
  });
});

authRouter.post('/logout', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    try {
      // Just try to consume it to clear it from Redis
      await tokenService.consumeRefreshToken(refreshToken);
    } catch (err) {
      // Ignore if already revoked
    }
  }

  res.json({ message: 'Logged out successfully' });
});

authRouter.post('/logout-all', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  await tokenService.revokeAllUserRefreshTokens(userId);
  res.json({ message: 'All sessions revoked' });
});

// ============================================================================
// Protected Test Route
// ============================================================================
authRouter.get('/me', requireAuth, userRateLimitMiddleware, async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const db = getDatabase();
  const repo = new UserRepository(db);
  const user = await repo.findById(userId);

  if (!user) throw new AuthenticationError('User not found');

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    authProvider: user.authProvider,
  });
});

import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { EnvConfig } from '../../config/index.js';
import { AuthenticationError } from '../errors/index.js';
import { User } from '../entities/index.js';
import { getRedis } from '../../infrastructure/redis/connection.js';

export interface TokenPayload {
  sub: string; // user id
  email: string;
  role: string;
  type: 'access' | 'refresh';
}

export class TokenService {
  constructor(
    private readonly config: EnvConfig,
    private readonly keys: { privateKey: string; publicKey: string },
  ) {}

  /** Issuing RS256 JWT Access Token */
  generateAccessToken(user: User): string {
    const payload: TokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      type: 'access',
    };

    return jwt.sign(payload, this.keys.privateKey, {
      algorithm: 'RS256',
      expiresIn: this.config.JWT_ACCESS_EXPIRY as any,
      jwtid: uuidv4(),
    });
  }

  /** Issuing RS256 JWT Refresh Token & saving hash in Redis for rotation logic */
  async generateRefreshToken(user: User): Promise<string> {
    const jti = uuidv4();
    const payload: TokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      type: 'refresh',
    };

    const token = jwt.sign(payload, this.keys.privateKey, {
      algorithm: 'RS256',
      expiresIn: this.config.JWT_REFRESH_EXPIRY as any,
      jwtid: jti,
    });

    // Store the refresh token ID in Redis to allow strict rotation/revocation
    // E.g., SET draftly:refresh_tokens:{userId}:{jti} "valid" EX 604800
    const expirySeconds = 7 * 24 * 60 * 60; // 7 days hardcoded for redis TTL mapping
    const redis = getRedis();
    await redis.setex(`draftly:refresh_tokens:${user.id}:${jti}`, expirySeconds, 'valid');

    return token;
  }

  /** Verifies either an access or refresh token */
  verifyToken(token: string, expectedType: 'access' | 'refresh'): TokenPayload {
    try {
      const decoded = jwt.verify(token, this.keys.publicKey, {
        algorithms: ['RS256'],
      }) as TokenPayload & { jti: string };

      if (decoded.type !== expectedType) {
        throw new AuthenticationError(`Expected ${expectedType} token`);
      }

      return decoded;
    } catch (err) {
      throw new AuthenticationError('Invalid or expired token');
    }
  }

  /** Validate refresh token against Redis whitelist, then invalidate it (Rotation) */
  async consumeRefreshToken(token: string): Promise<TokenPayload> {
    const decoded = jwt.verify(token, this.keys.publicKey, {
      algorithms: ['RS256'],
    }) as TokenPayload & { jti: string };

    if (decoded.type !== 'refresh') {
      throw new AuthenticationError('Not a refresh token');
    }

    const key = `draftly:refresh_tokens:${decoded.sub}:${decoded.jti}`;
    const redis = getRedis();
    const isValid = await redis.get(key);

    if (!isValid) {
      // Token was already used or revoked! Potential token theft.
      // Eagerly delete ALL refresh tokens for this user for safety.
      const userKeys = await redis.keys(`draftly:refresh_tokens:${decoded.sub}:*`);
      if (userKeys.length > 0) {
        await redis.del(...userKeys);
      }
      throw new AuthenticationError('Refresh token reuse detected. All sessions revoked.');
    }

    // Token is valid, "consume" it by deleting it
    await redis.del(key);

    return decoded;
  }

  /** Revoke all tokens for a user by deleting from Redis */
  async revokeAllUserRefreshTokens(userId: string): Promise<void> {
    const redis = getRedis();
    const userKeys = await redis.keys(`draftly:refresh_tokens:${userId}:*`);
    if (userKeys.length > 0) {
      await redis.del(...userKeys);
    }
  }
}

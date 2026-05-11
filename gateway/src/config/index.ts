import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dotenv from 'dotenv';

// Try to load the root .env file if running locally
const envPath = path.resolve(process.cwd(), '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  // Fallback to standard dotenv loading for Docker environments
  dotenv.config();
}

const envSchema = z.object({
  // App
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PORT: z.coerce.number().default(3000),
  CORS_ORIGINS: z.string().default('http://localhost:3001'),

  // Database (via PgBouncer)
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().default(6432),
  DB_NAME: z.string().default('draftly'),
  DB_USER: z.string().default('draftly'),
  DB_PASSWORD: z.string(),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Google OAuth (login)
  GOOGLE_CLIENT_ID: z.string(),
  GOOGLE_CLIENT_SECRET: z.string(),
  GOOGLE_CALLBACK_URL: z.string().default('http://localhost:3000/api/v1/auth/google/callback'),

  // Gmail OAuth (mail scopes)
  GMAIL_CALLBACK_URL: z.string().default('http://localhost:3000/api/v1/connections/callback'),

  // JWT (RS256)
  JWT_PRIVATE_KEY_PATH: z.string().default('./keys/private.pem'),
  JWT_PUBLIC_KEY_PATH: z.string().default('./keys/public.pem'),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('7d'),

  // Encryption
  SECRET_ENCRYPTION_KEY: z.string().min(64, 'Must be 32-byte hex string (64 hex chars)'),

  // LLM
  GEMINI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),

  // Admin
  ADMIN_API_KEY: z.string().default('dev-admin-key'),

  // Rate limits
  RATE_LIMIT_IP_PER_MIN: z.coerce.number().default(200),
  RATE_LIMIT_USER_PER_MIN: z.coerce.number().default(100),

  // Triage
  TRIAGE_BATCH_SIZE: z.coerce.number().default(25),
});

export type EnvConfig = z.infer<typeof envSchema>;

let _config: EnvConfig | null = null;

export function loadConfig(): EnvConfig {
  if (_config) return _config;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    console.error(`❌ Invalid environment configuration:\n${formatted}`);
    process.exit(1);
  }

  _config = result.data;
  return _config;
}

/** Load JWT keys from filesystem. Called once at startup. */
export function loadJwtKeys(config: EnvConfig): { privateKey: string; publicKey: string } {
  const resolvePath = (p: string) =>
    path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);

  const privateKey = fs.readFileSync(resolvePath(config.JWT_PRIVATE_KEY_PATH), 'utf-8');
  const publicKey = fs.readFileSync(resolvePath(config.JWT_PUBLIC_KEY_PATH), 'utf-8');

  return { privateKey, publicKey };
}

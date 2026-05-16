import knex, { Knex } from 'knex';
import { EnvConfig } from '../../config/index.js';
import { logger } from '../../shared/logger.js';
import * as fs from 'node:fs';

let _db: Knex | null = null;

export function createDatabase(config: EnvConfig): Knex {
  if (_db) return _db;

  const sslEnabled = config.DB_SSL === true;
  const ssl =
    sslEnabled
      ? {
          rejectUnauthorized: config.DB_SSL_REJECT_UNAUTHORIZED !== false,
          ca: config.DB_SSL_CA
            ? (fs.existsSync(config.DB_SSL_CA) ? fs.readFileSync(config.DB_SSL_CA, 'utf-8') : config.DB_SSL_CA)
            : undefined,
        }
      : undefined;

  _db = knex({
    client: 'pg',
    connection: {
      host: config.DB_HOST,
      port: config.DB_PORT,
      database: config.DB_NAME,
      user: config.DB_USER,
      password: config.DB_PASSWORD,
      ssl,
    },
    pool: {
      min: 2,
      max: 20,
      acquireTimeoutMillis: 10000,
      createTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
    },
    log: {
      warn: (msg: string) => logger.warn(msg),
      error: (msg: string) => logger.error(msg),
      debug: (msg: string) => logger.debug(msg),
    },
  });

  return _db;
}

export function getDatabase(): Knex {
  if (!_db) throw new Error('Database not initialized. Call createDatabase() first.');
  return _db;
}

export async function destroyDatabase(): Promise<void> {
  if (_db) {
    await _db.destroy();
    _db = null;
  }
}

import knex, { Knex } from 'knex';
import { EnvConfig } from '../../config/index.js';
import { logger } from '../../shared/logger.js';

let _db: Knex | null = null;

export function createDatabase(config: EnvConfig): Knex {
  if (_db) return _db;

  _db = knex({
    client: 'pg',
    connection: {
      host: config.DB_HOST,
      port: config.DB_PORT,
      database: config.DB_NAME,
      user: config.DB_USER,
      password: config.DB_PASSWORD,
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

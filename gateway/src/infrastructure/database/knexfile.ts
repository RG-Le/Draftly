import type { Knex } from 'knex';
import * as path from 'node:path';
import * as url from 'node:url';
import { config as dotenvConfig } from 'dotenv';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname, '../../../../.env') });

// This is the Knex config used by the CLI for migrations.
// It reads DB connection info from environment variables.

const config: Knex.Config = {
  client: 'pg',
  connection: {
    // DDL operations must bypass PgBouncer (which is in transaction pooling mode).
    // If DB_HOST is 'pgbouncer' (from .env), we override to 'localhost' to hit PG directly on 5432.
    host: process.env.DB_HOST === 'pgbouncer' ? 'localhost' : process.env.DB_HOST || 'localhost',
    port: 5432,
    database: process.env.DB_NAME || 'draftly',
    user: process.env.DB_USER || 'draftly',
    password: process.env.DB_PASSWORD || 'draftly_dev',
  },
  migrations: {
    directory: path.resolve(__dirname, 'migrations'),
    extension: 'ts',
    tableName: 'knex_migrations',
  },
  seeds: {
    directory: path.resolve(__dirname, 'seeds'),
    extension: 'ts',
  },
};

export default config;

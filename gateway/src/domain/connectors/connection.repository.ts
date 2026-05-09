import { Knex } from 'knex';
import { UserConnection } from '../entities/index.js';

/**
 * Repository for user_connections table.
 * Stores encrypted OAuth tokens per connector per user.
 */
export class ConnectionRepository {
  constructor(private readonly db: Knex) {}

  async findByUserAndType(userId: string, connectorType: string): Promise<UserConnection | null> {
    const row = await this.db('user_connections')
      .where({ user_id: userId, connector_type: connectorType })
      .first();
    return row ? this.mapToDomain(row) : null;
  }

  async findAllByUser(userId: string): Promise<UserConnection[]> {
    const rows = await this.db('user_connections').where({ user_id: userId });
    return rows.map((r: any) => this.mapToDomain(r));
  }

  async upsert(conn: {
    userId: string;
    connectorType: string;
    encryptedAccessToken: Buffer;
    encryptedRefreshToken: Buffer;
    tokenExpiresAt: Date;
    status: string;
    connectorMetadata?: Record<string, unknown> | null;
  }): Promise<UserConnection> {
    const existing = await this.findByUserAndType(conn.userId, conn.connectorType);

    if (existing) {
      const [updated] = await this.db('user_connections')
        .where({ id: existing.id })
        .update({
          encrypted_access_token: conn.encryptedAccessToken,
          encrypted_refresh_token: conn.encryptedRefreshToken,
          token_expires_at: conn.tokenExpiresAt,
          status: conn.status,
          connector_metadata: conn.connectorMetadata ? JSON.stringify(conn.connectorMetadata) : null,
          updated_at: new Date(),
        })
        .returning('*');
      return this.mapToDomain(updated);
    }

    const [created] = await this.db('user_connections')
      .insert({
        user_id: conn.userId,
        connector_type: conn.connectorType,
        encrypted_access_token: conn.encryptedAccessToken,
        encrypted_refresh_token: conn.encryptedRefreshToken,
        token_expires_at: conn.tokenExpiresAt,
        status: conn.status,
        connector_metadata: conn.connectorMetadata ? JSON.stringify(conn.connectorMetadata) : null,
      })
      .returning('*');
    return this.mapToDomain(created);
  }

  async updateSyncStatus(
    connectionId: string,
    status: string,
    error: string | null,
  ): Promise<void> {
    await this.db('user_connections')
      .where({ id: connectionId })
      .update({
        last_synced_at: new Date(),
        last_sync_status: status,
        last_sync_error: error,
        updated_at: new Date(),
      });
  }

  async updateTokens(
    connectionId: string,
    encryptedAccessToken: Buffer,
    tokenExpiresAt: Date,
    encryptedRefreshToken?: Buffer,
  ): Promise<void> {
    const update: Record<string, unknown> = {
      encrypted_access_token: encryptedAccessToken,
      token_expires_at: tokenExpiresAt,
      status: 'active',
      updated_at: new Date(),
    };
    if (encryptedRefreshToken) {
      update.encrypted_refresh_token = encryptedRefreshToken;
    }
    await this.db('user_connections').where({ id: connectionId }).update(update);
  }

  async markRevoked(connectionId: string): Promise<void> {
    await this.db('user_connections')
      .where({ id: connectionId })
      .update({ status: 'revoked', updated_at: new Date() });
  }

  private mapToDomain(row: any): UserConnection {
    return {
      id: row.id,
      userId: row.user_id,
      connectorType: row.connector_type,
      encryptedAccessToken: row.encrypted_access_token,
      encryptedRefreshToken: row.encrypted_refresh_token,
      tokenExpiresAt: row.token_expires_at,
      status: row.status,
      connectorMetadata: typeof row.connector_metadata === 'string'
        ? JSON.parse(row.connector_metadata)
        : row.connector_metadata,
      lastSyncedAt: row.last_synced_at,
      lastSyncStatus: row.last_sync_status,
      lastSyncError: row.last_sync_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

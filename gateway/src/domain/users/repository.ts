import { Knex } from 'knex';
import { User } from '../entities/index.js';

export class UserRepository {
  constructor(private readonly db: Knex) {}

  async findById(id: string): Promise<User | null> {
    const user = await this.db('users').where({ id }).first();
    return user ? this.mapToDomain(user) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const user = await this.db('users').where({ email }).first();
    return user ? this.mapToDomain(user) : null;
  }

  async findByGoogleSub(googleSub: string): Promise<User | null> {
    const user = await this.db('users').where({ google_sub: googleSub }).first();
    return user ? this.mapToDomain(user) : null;
  }

  async create(user: Omit<User, 'id' | 'createdAt' | 'updatedAt'>): Promise<User> {
    const [created] = await this.db('users')
      .insert({
        email: user.email,
        name: user.name,
        password_hash: user.passwordHash,
        auth_provider: user.authProvider,
        google_sub: user.googleSub,
        role: user.role,
        is_active: user.isActive,
      })
      .returning('*');
    return this.mapToDomain(created);
  }

  private mapToDomain(row: any): User {
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      passwordHash: row.password_hash,
      authProvider: row.auth_provider,
      googleSub: row.google_sub,
      role: row.role,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

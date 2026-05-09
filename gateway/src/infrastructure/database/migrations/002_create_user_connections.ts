import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_connections', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.string('connector_type', 50).notNullable();
    table.binary('encrypted_access_token').notNullable();
    table.binary('encrypted_refresh_token').notNullable();
    table.timestamp('token_expires_at', { useTz: true }).notNullable();
    table.string('status', 20).notNullable().defaultTo('active');
    table.jsonb('connector_metadata').nullable();
    table.timestamp('last_synced_at', { useTz: true }).nullable();
    table.string('last_sync_status', 20).nullable();
    table.text('last_sync_error').nullable();
    table.timestamps(true, true);

    table.index(['user_id', 'status']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('user_connections');
}

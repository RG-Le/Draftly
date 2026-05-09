import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('email_threads', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('connection_id').notNullable().references('id').inTable('user_connections').onDelete('CASCADE');
    table.string('external_thread_id', 255).notNullable();
    table.text('subject').nullable();
    table.jsonb('participants').nullable();
    table.integer('message_count').defaultTo(0);
    table.timestamp('last_message_at', { useTz: true }).nullable();
    table.string('sync_status', 20).defaultTo('synced');
    table.timestamps(true, true);

    table.unique(['connection_id', 'external_thread_id']);
    table.index(['connection_id', 'last_message_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('email_threads');
}

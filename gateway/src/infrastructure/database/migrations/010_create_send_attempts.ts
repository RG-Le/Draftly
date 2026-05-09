import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('send_attempts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('draft_id').notNullable().references('id').inTable('drafts').onDelete('CASCADE');
    table.string('idempotency_key', 255).notNullable().unique();
    table.string('status', 20).notNullable().defaultTo('pending');
    table.string('external_message_id', 255).nullable();
    table.text('error_message').nullable();
    table.integer('attempt_number').notNullable().defaultTo(1);
    table.timestamp('queued_at', { useTz: true }).notNullable();
    table.timestamp('started_at', { useTz: true }).nullable();
    table.timestamp('completed_at', { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('send_attempts');
}

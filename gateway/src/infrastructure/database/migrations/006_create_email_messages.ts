import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('email_messages', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('thread_id').notNullable().references('id').inTable('email_threads').onDelete('CASCADE');
    table.string('external_message_id', 255).notNullable().unique();
    table.string('from_address', 255).notNullable();
    table.jsonb('to_addresses').notNullable();
    table.jsonb('cc_addresses').nullable();
    table.text('subject').nullable();
    table.text('body_text').nullable();
    table.text('body_html').nullable();
    table.jsonb('raw_headers').nullable();
    table.timestamp('received_at', { useTz: true }).notNullable();
    table.boolean('is_sent_by_user').notNullable().defaultTo(false);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['thread_id', 'received_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('email_messages');
}

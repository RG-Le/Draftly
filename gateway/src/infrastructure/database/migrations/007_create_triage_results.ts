import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('triage_results', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('thread_id').notNullable().references('id').inTable('email_threads').onDelete('CASCADE').unique();
    table.string('classification', 50).notNullable();
    table.string('method', 20).notNullable();
    table.decimal('confidence', 3, 2).nullable();
    table.text('reasoning').nullable();
    table.jsonb('llm_metadata').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('triage_results');
}

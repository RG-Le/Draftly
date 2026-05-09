import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('drafts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('thread_id').notNullable().references('id').inTable('email_threads').onDelete('CASCADE');
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.text('generated_content').nullable();
    table.text('current_content').nullable();
    table.string('status', 20).notNullable();
    table.integer('version').notNullable().defaultTo(1);
    table.jsonb('generation_metadata').nullable();
    table.string('idempotency_key', 255).nullable().unique();
    table.timestamps(true, true);

    table.index(['user_id', 'status']);
    table.index(['thread_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('drafts');
}

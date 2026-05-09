import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Configurable prompt templates for AI Engine
  await knex.schema.createTable('prompt_templates', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('name', 100).notNullable().unique();
    table.text('description').nullable();
    table.text('system_prompt').notNullable();
    table.text('user_prompt_template').notNullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS prompt_templates CASCADE');
}

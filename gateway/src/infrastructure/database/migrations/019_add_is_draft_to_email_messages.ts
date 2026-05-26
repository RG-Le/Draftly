import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('email_messages', (table) => {
    table.boolean('is_draft').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('email_messages', (table) => {
    table.dropColumn('is_draft');
  });
}

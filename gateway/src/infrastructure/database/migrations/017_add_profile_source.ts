import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_profiles', (table) => {
    table.string('profile_source', 20).notNullable().defaultTo('default');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_profiles', (table) => {
    table.dropColumn('profile_source');
  });
}

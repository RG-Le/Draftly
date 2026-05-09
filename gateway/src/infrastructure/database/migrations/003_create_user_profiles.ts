import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_profiles', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE').unique();
    table.jsonb('greeting_style').nullable();
    table.jsonb('closing_style').nullable();
    table.text('signature_template').nullable();
    table.string('preferred_tone', 50).nullable();
    table.jsonb('communication_norms').nullable();
    table.jsonb('current_priorities').nullable();
    table.integer('profile_version').notNullable().defaultTo(1);
    table.decimal('confidence_score', 3, 2).defaultTo(0.0);
    table.timestamp('last_calibrated_at', { useTz: true }).nullable();
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('user_profiles');
}

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Audit logs — partitioned by created_at (monthly)
  await knex.raw(`
    CREATE TABLE audit_logs (
      id UUID DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL,
      entity_type VARCHAR(50) NOT NULL,
      entity_id UUID NOT NULL,
      action VARCHAR(50) NOT NULL,
      changes JSONB,
      ip_address VARCHAR(45),
      correlation_id VARCHAR(100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (id, created_at)
    ) PARTITION BY RANGE (created_at);
  `);

  // Note: user_id is NOT a FK — audit logs survive user deletion

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  for (let i = 0; i <= 2; i++) {
    const partMonth = month + i;
    const partYear = year + Math.floor(partMonth / 12);
    const partMonthNorm = (partMonth % 12) + 1;
    const nextMonth = partMonthNorm + 1 > 12 ? 1 : partMonthNorm + 1;
    const nextYear = nextMonth === 1 ? partYear + 1 : partYear;
    const partName = `audit_logs_${partYear}_${String(partMonthNorm).padStart(2, '0')}`;

    await knex.raw(`
      CREATE TABLE IF NOT EXISTS ${partName}
      PARTITION OF audit_logs
      FOR VALUES FROM ('${partYear}-${String(partMonthNorm).padStart(2, '0')}-01')
      TO ('${nextYear}-${String(nextMonth).padStart(2, '0')}-01');
    `);
  }

  await knex.raw('CREATE INDEX idx_audit_user ON audit_logs (user_id, created_at DESC)');
  await knex.raw('CREATE INDEX idx_audit_correlation ON audit_logs (correlation_id) WHERE correlation_id IS NOT NULL');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS audit_logs CASCADE');
}

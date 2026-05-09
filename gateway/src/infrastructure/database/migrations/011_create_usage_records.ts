import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Usage records — partitioned by usage_date (monthly)
  // Knex doesn't support native partitioning, so we use raw SQL.
  await knex.raw(`
    CREATE TABLE usage_records (
      id UUID DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      resource_type VARCHAR(50) NOT NULL,
      resource_detail VARCHAR(200),
      quantity INTEGER NOT NULL,
      estimated_cost_usd DECIMAL(10, 6),
      usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
      correlation_id VARCHAR(100),
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (id, usage_date)
    ) PARTITION BY RANGE (usage_date);
  `);

  // Create initial partitions (current month + next month)
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed

  for (let i = 0; i <= 2; i++) {
    const partMonth = month + i;
    const partYear = year + Math.floor(partMonth / 12);
    const partMonthNorm = (partMonth % 12) + 1;
    const nextMonth = partMonthNorm + 1 > 12 ? 1 : partMonthNorm + 1;
    const nextYear = nextMonth === 1 ? partYear + 1 : partYear;
    const partName = `usage_records_${partYear}_${String(partMonthNorm).padStart(2, '0')}`;

    await knex.raw(`
      CREATE TABLE IF NOT EXISTS ${partName}
      PARTITION OF usage_records
      FOR VALUES FROM ('${partYear}-${String(partMonthNorm).padStart(2, '0')}-01')
      TO ('${nextYear}-${String(nextMonth).padStart(2, '0')}-01');
    `);
  }

  await knex.raw('CREATE INDEX idx_usage_user_date ON usage_records (user_id, usage_date)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS usage_records CASCADE');
}

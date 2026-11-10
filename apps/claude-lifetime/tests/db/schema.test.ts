import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { METHODS, MODELS, PRICES } from '@/core/catalog';
import { migrate } from '@/db/migrate';
import { MIGRATIONS } from '@/db/migrations.generated';
import { pgliteDriver } from '@/db/pglite-driver';
import { ensureSeeded } from '@/db/seed';
import { createTestDb, type TestDb } from '../helpers/db';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

describe('migrations', () => {
  it('creates every table of the Prisma schema plus the analytics view', async () => {
    const { rows } = await t.db.query<{ table_name: string; table_type: string }>(
      `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
    );
    const names = rows.map((r) => r.table_name);
    for (const expected of [
      'users', 'data_sources', 'import_batches', 'conversations', 'messages', 'usage_records',
      'token_estimates', 'estimate_buckets', 'estimation_methods', 'reported_costs', 'subscription_periods',
      'model_catalog', 'pricing_history', 'synced_files',
    ]) {
      expect(names).toContain(expected);
    }
    expect(rows.find((r) => r.table_name === 'usage_facts')?.table_type).toBe('VIEW');
  });

  it('records applied migrations and is idempotent', async () => {
    const again = await migrate(t.db);
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toEqual(MIGRATIONS.map((m) => m.name));
  });

  it('applies each migration once when two tabs start on an empty database together', async () => {
    const pg = new PGlite();
    const db = pgliteDriver(pg);
    try {
      const [first, second] = await Promise.all([migrate(db), migrate(db)]);
      // Between them they applied everything, and nothing twice.
      expect([...first.applied, ...second.applied].sort()).toEqual(MIGRATIONS.map((m) => m.name));
      expect(first.applied.length + first.alreadyApplied.length).toBe(MIGRATIONS.length);
      expect(second.applied.length + second.alreadyApplied.length).toBe(MIGRATIONS.length);
      const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "_prisma_migrations"`);
      expect(rows[0].n).toBe(MIGRATIONS.length);
      // Seeding from both at once ends with one user and one copy of the catalog as well.
      const [a, b] = await Promise.all([ensureSeeded(db), ensureSeeded(db)]);
      expect(a).toBe(b);
      const users = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
      expect(users.rows[0].n).toBe(1);
      const prices = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pricing_history WHERE is_builtin`);
      expect(prices.rows[0].n).toBe(PRICES.length);
    } finally {
      await db.close();
    }
  });

  it('refuses to run when an applied migration was edited', async () => {
    const tampered = MIGRATIONS.map((m, i) => (i === 0 ? { ...m, checksum: 'f'.repeat(64) } : m));
    await expect(migrate(t.db, tampered)).rejects.toThrow(/changed after it was applied/);
  });

  it('rolls a failing migration back completely', async () => {
    const broken = [...MIGRATIONS, { name: '99999999999999_broken', checksum: 'a'.repeat(64), sql: 'CREATE TABLE "half_done" (id int); SELECT 1/0;' }];
    await expect(migrate(t.db, broken)).rejects.toThrow(/rolled back/);
    const { rows } = await t.db.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'half_done'`);
    expect(rows).toHaveLength(0);
  });
});

describe('seed', () => {
  it('creates one local user and the built-in catalog', async () => {
    const users = await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
    expect(users.rows[0].n).toBe(1);
    const models = await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM model_catalog`);
    expect(models.rows[0].n).toBe(MODELS.length);
    const prices = await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pricing_history`);
    expect(prices.rows[0].n).toBe(PRICES.length);
    const methods = await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM estimation_methods`);
    expect(methods.rows[0].n).toBe(METHODS.length);
  });

  it('stores prices exactly, with source and retrieval date', async () => {
    const { rows } = await t.db.query<Record<string, string>>(
      `SELECT p.input_usd_per_mtok::text AS input, p.output_usd_per_mtok::text AS output,
              p.cache_read_usd_per_mtok::text AS cache_read, p.cache_write_5m_usd_per_mtok::text AS cw5,
              p.cache_write_1h_usd_per_mtok::text AS cw1h, p.source_url, p.source_retrieved_on::text AS retrieved
         FROM pricing_history p JOIN model_catalog m ON m.id = p.model_id
        WHERE m.model_key = 'claude-opus-5-5' AND p.price_tier = 'standard'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      input: '4.000000', output: '20.000000', cache_read: '0.200000', cw5: '5.000000', cw1h: '8.000000',
      source_url: 'https://platform.claude.com/docs/en/about-claude/pricing', retrieved: '2026-11-10',
    });
  });
});

describe('constraints', () => {
  it('rejects overlapping subscription periods for the same user', async () => {
    await t.reset();
    await t.db.query(
      `INSERT INTO subscription_periods (user_id, plan_key, started_at, ended_at) VALUES ($1, 'pro', '2025-01-01Z', '2025-06-01Z')`,
      [t.userId],
    );
    // touching periods are fine: [start, end) is half-open
    await t.db.query(
      `INSERT INTO subscription_periods (user_id, plan_key, started_at, ended_at) VALUES ($1, 'max', '2025-06-01Z', NULL)`,
      [t.userId],
    );
    await expect(
      t.db.query(`INSERT INTO subscription_periods (user_id, plan_key, started_at, ended_at) VALUES ($1, 'pro', '2025-03-01Z', '2025-04-01Z')`, [t.userId]),
    ).rejects.toThrow(/subscription_periods_no_overlap/);
    await expect(
      t.db.query(`INSERT INTO subscription_periods (user_id, plan_key, started_at, ended_at) VALUES ($1, 'pro', '2026-01-01Z', NULL)`, [t.userId]),
    ).rejects.toThrow(/subscription_periods_no_overlap/);
  });

  it('rejects a period that ends before it starts', async () => {
    await t.reset();
    await expect(
      t.db.query(`INSERT INTO subscription_periods (user_id, plan_key, started_at, ended_at) VALUES ($1, 'pro', '2025-06-01Z', '2025-01-01Z')`, [t.userId]),
    ).rejects.toThrow(/subscription_periods_range|range lower bound/);
  });
});

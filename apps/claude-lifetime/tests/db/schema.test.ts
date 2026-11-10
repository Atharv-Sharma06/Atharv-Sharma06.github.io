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
  const period = (plan: string, start: string, last: string | null) =>
    t.db.query(`INSERT INTO subscription_periods (user_id, plan_key, start_date, last_date) VALUES ($1, $2, $3::date, $4::date)`, [t.userId, plan, start, last]);

  it('rejects overlapping subscription periods for the same user', async () => {
    await t.reset();
    await period('pro', '2025-01-01', '2025-05-31');
    // periods that follow each other are fine: the next one starts the day after the last day
    await period('max', '2025-06-01', null);
    await expect(period('pro', '2025-03-01', '2025-03-31')).rejects.toThrow(/subscription_periods_no_overlap/);
    // an open-ended period covers every later day
    await expect(period('pro', '2026-01-01', null)).rejects.toThrow(/subscription_periods_no_overlap/);
    // the last day belongs to the period, so another one cannot start on it
    await expect(period('team', '2025-05-31', '2025-05-31')).rejects.toThrow(/subscription_periods_no_overlap/);
    // a single free day in front is enough room
    await period('free', '2024-12-31', '2024-12-31');
  });

  it('rejects a period that ends before it starts', async () => {
    await t.reset();
    await expect(period('pro', '2025-06-01', '2025-01-01')).rejects.toThrow(/subscription_periods_range|range lower bound/);
    // one day long is the shortest period there is
    await period('pro', '2025-06-01', '2025-06-01');
  });
});

describe('the move of subscription periods from instants to calendar days', () => {
  const BEFORE = MIGRATIONS.filter((m) => m.name < '20261110000300');
  const open = async (timezone: string) => {
    const db = pgliteDriver(new PGlite());
    await migrate(db, BEFORE);
    const userId = await ensureSeededWithout(db, timezone);
    return { db, userId };
  };
  // The catalog seed needs the whole schema; a bare user is enough for these rows.
  const ensureSeededWithout = async (db: ReturnType<typeof pgliteDriver>, timezone: string) =>
    (await db.query<{ id: number }>(`INSERT INTO users (timezone) VALUES ($1) RETURNING id`, [timezone])).rows[0].id;
  const old = (db: ReturnType<typeof pgliteDriver>, userId: number, plan: string, startedAt: string, endedAt: string | null) =>
    db.query(`INSERT INTO subscription_periods (user_id, plan_key, started_at, ended_at, monthly_price) VALUES ($1, $2, $3::timestamptz, $4::timestamptz, 20)`, [userId, plan, startedAt, endedAt]);
  const days = async (db: ReturnType<typeof pgliteDriver>) =>
    (await db.query<{ plan_key: string; s: string; l: string | null }>(`SELECT plan_key, start_date::text AS s, last_date::text AS l FROM subscription_periods ORDER BY start_date`)).rows.map((r) => [r.plan_key, r.s, r.l]);

  it('keeps the days every period showed, in the timezone that is set', async () => {
    const { db, userId } = await open('America/New_York');
    try {
      // entered in New York as Free 1–31 January, Pro 1–28 February, Max from 9 March (local midnights as instants)
      await old(db, userId, 'free', '2025-01-01T05:00:00Z', '2025-02-01T05:00:00Z');
      await old(db, userId, 'pro', '2025-02-01T05:00:00Z', '2025-03-01T05:00:00Z');
      await old(db, userId, 'max', '2025-03-09T05:00:00Z', null);
      await migrate(db);
      expect(await days(db)).toEqual([
        ['free', '2025-01-01', '2025-01-31'],
        ['pro', '2025-02-01', '2025-02-28'],
        ['max', '2025-03-09', null],
      ]);
      const columns = await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'subscription_periods'`);
      expect(columns.rows.map((r) => r.column_name)).not.toContain('started_at');
      expect(columns.rows.map((r) => r.column_name)).not.toContain('ended_at');
      // the constraints are back, on days
      await expect(db.query(`INSERT INTO subscription_periods (user_id, plan_key, start_date) VALUES ($1, 'pro', '2025-02-28')`, [userId])).rejects.toThrow(/no_overlap/);
    } finally {
      await db.close();
    }
  });

  it('settles neighbours that would share a day because the timezone was changed after they were entered', async () => {
    // Entered in New York, but the app is set to Berlin by now: both periods show 1 February.
    const { db, userId } = await open('Europe/Berlin');
    try {
      await old(db, userId, 'free', '2025-01-01T05:00:00Z', '2025-02-01T05:00:00Z');
      await old(db, userId, 'pro', '2025-02-01T05:00:00Z', '2025-03-01T05:00:00Z');
      await migrate(db);
      expect(await days(db)).toEqual([
        ['free', '2025-01-01', '2025-01-31'],
        ['pro', '2025-02-01', '2025-03-01'],
      ]);
    } finally {
      await db.close();
    }
  });

  it('reads the last day of a period that ended at a midnight skipped by daylight saving', async () => {
    const { db, userId } = await open('America/Santiago');
    try {
      // last day 6 September 2025; the clocks jump from 00:00 to 01:00 on the 7th, which is 04:00 UTC
      await old(db, userId, 'pro', '2025-08-01T04:00:00Z', '2025-09-07T04:00:00Z');
      await migrate(db);
      expect(await days(db)).toEqual([['pro', '2025-08-01', '2025-09-06']]);
    } finally {
      await db.close();
    }
  });

  it('does not add a day to a period that ended at a midnight that happens twice', async () => {
    const { db, userId } = await open('America/Havana');
    try {
      // entered as 1 October – 1 November 2025; on 2 November the clocks go back from 01:00 to
      // 00:00, and PostgreSQL resolved that midnight to the second one (05:00 UTC)
      await old(db, userId, 'pro', '2025-10-01T04:00:00Z', '2025-11-02T05:00:00Z');
      // the same day, stored as the first of the two midnights (04:00 UTC)
      await old(db, userId, 'max', '2026-10-01T04:00:00Z', '2026-11-01T04:00:00Z');
      await migrate(db);
      expect(await days(db)).toEqual([
        ['pro', '2025-10-01', '2025-11-01'],
        ['max', '2026-10-01', '2026-10-31'],
      ]);
    } finally {
      await db.close();
    }
  });

  it('never fails when periods entered in another timezone land on the same first day', async () => {
    // A one-day period on the 23-hour day of New York (9 March 2025) and a plan from the next
    // day, read in Bogota (UTC-5 all year): both start on 9 March there.
    const bogota = await open('America/Bogota');
    try {
      await old(bogota.db, bogota.userId, 'pro', '2025-03-09T05:00:00Z', '2025-03-10T04:00:00Z');
      await old(bogota.db, bogota.userId, 'max', '2025-03-10T04:00:00Z', null);
      await migrate(bogota.db);
      expect(await days(bogota.db)).toEqual([
        ['pro', '2025-03-09', '2025-03-09'],
        ['max', '2025-03-10', null],
      ]);
    } finally {
      await bogota.db.close();
    }
    // Three periods entered in Berlin around the day clocks go forward, read in Lagos (UTC+1 all year).
    const lagos = await open('Africa/Lagos');
    try {
      await old(lagos.db, lagos.userId, 'free', '2025-03-01T23:00:00Z', '2025-03-29T23:00:00Z');
      await old(lagos.db, lagos.userId, 'pro', '2025-03-29T23:00:00Z', '2025-03-30T22:00:00Z');
      await old(lagos.db, lagos.userId, 'max', '2025-03-30T22:00:00Z', null);
      await migrate(lagos.db);
      expect(await days(lagos.db)).toEqual([
        ['free', '2025-03-02', '2025-03-29'],
        ['pro', '2025-03-30', '2025-03-30'],
        ['max', '2025-03-31', null],
      ]);
    } finally {
      await lagos.db.close();
    }
  });

  it('gives every period its own first day when several fall on one, and reads an unknown timezone as UTC', async () => {
    const { db, userId } = await open('Not/AZone');
    try {
      // three one-hour periods of one UTC day, then a running plan the same day
      await old(db, userId, 'free', '2025-05-01T01:00:00Z', '2025-05-01T02:00:00Z');
      await old(db, userId, 'pro', '2025-05-01T02:00:00Z', '2025-05-01T03:00:00Z');
      await old(db, userId, 'team', '2025-05-01T03:00:00Z', '2025-05-01T04:00:00Z');
      await old(db, userId, 'max', '2025-05-01T04:00:00Z', null);
      await migrate(db);
      expect(await days(db)).toEqual([
        ['free', '2025-05-01', '2025-05-01'],
        ['pro', '2025-05-02', '2025-05-02'],
        ['team', '2025-05-03', '2025-05-03'],
        ['max', '2025-05-04', null],
      ]);
    } finally {
      await db.close();
    }
  });
});

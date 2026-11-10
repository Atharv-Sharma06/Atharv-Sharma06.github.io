import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../helpers/db';

/**
 * docs/ARCHITECTURE.md is what a developer reads before writing a query or moving the
 * schema to a server. Its statements about the tables are checked here against the
 * database the migrations build, so that the document cannot claim a separation or a
 * column the schema does not have.
 */
const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');
const architecture = read('docs/ARCHITECTURE.md').replace(/\s+/g, ' ');

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

const tablesWith = async (column: string, has: boolean) => {
  const { rows } = await t.db.query<{ table_name: string }>(
    `SELECT t.table_name FROM information_schema.tables t
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND ${has ? '' : 'NOT'} EXISTS (SELECT 1 FROM information_schema.columns c
                     WHERE c.table_schema = 'public' AND c.table_name = t.table_name AND c.column_name = $1)
      ORDER BY 1`,
    [column],
  );
  // Left out: the migration runner's bookkeeping, and the staging tables of an import in progress.
  return rows.map((r) => r.table_name).filter((name) => !name.startsWith('_') && !name.startsWith('stg_'));
};

describe('docs/ARCHITECTURE.md, on where exact and estimated usage are stored', () => {
  it('does not call usage_records a table of exact usage, because it holds estimated rows too', async () => {
    // usage_records has a confidence column that admits both values.
    const { rows } = await t.db.query<{ v: string }>(`SELECT unnest(enum_range(NULL::confidence))::text AS v`);
    expect(rows.map((r) => r.v).sort()).toEqual(['estimated', 'exact']);
    expect(await tablesWith('confidence', true)).toContain('usage_records');

    expect(architecture).not.toContain('Exact and estimated usage live in different tables');
    expect(architecture).not.toContain('| `usage_records` | **Exact** usage');
    expect(architecture).toContain('| `usage_records` | Usage whose token counts a file states');
    expect(architecture).toContain('it is not a table of exact usage');
  });
});

describe('docs/ARCHITECTURE.md, on which tables carry user_id', () => {
  it('names exactly the tables that have the column, and those that do not', async () => {
    expect(architecture).not.toContain('`user_id` is on every row');

    const withUser = await tablesWith('user_id', true);
    const listed = architecture.match(/`user_id` is on the tables that hold a person's data: (.*?)\. /)?.[1] ?? '';
    const named = [...listed.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).sort();
    expect(named).toEqual(withUser);

    const without = await tablesWith('user_id', false);
    const paragraph = architecture.match(/`user_id` is on the tables .*? everybody's usage\./)?.[0] ?? '';
    // The users table is the user; every other table without the column is named, with what becomes of it on a server.
    expect(without.filter((name) => name !== 'users' && !paragraph.includes(`\`${name}\``))).toEqual([]);
    expect(without).toEqual(['estimation_methods', 'messages', 'model_catalog', 'pricing_history', 'synced_files', 'users']);
    expect(architecture).toContain('Three tables are shared by everyone in the database: `model_catalog`');
  });
});

describe('npm run db:migration', () => {
  it('can read the migrations folder, which Prisma refuses without a lock file naming the database', () => {
    const lock = fileURLToPath(new URL('../../prisma/migrations/migration_lock.toml', import.meta.url));
    expect(existsSync(lock)).toBe(true);
    expect(read('prisma/migrations/migration_lock.toml')).toMatch(/^provider = "postgresql"$/m);
  });

  it('reads the variables from the file .env.example tells people to create', () => {
    const config = read('prisma.config.ts');
    expect(read('.env.example')).toContain('Copy this file to .env.local');
    expect(config).toContain('new URL(".env.local", import.meta.url)');
    expect(config).toContain('process.loadEnvFile(envFile)');
    // The shadow database is erased by the command, so only a variable named for it may set it.
    expect(config).toContain('shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL || undefined');
    expect(read('.env.example')).toMatch(/^# SHADOW_DATABASE_URL=/m);
  });
});

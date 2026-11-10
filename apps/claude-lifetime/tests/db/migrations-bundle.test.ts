import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '@/db/migrations.generated';

/**
 * The browser cannot read prisma/migrations, so the SQL is bundled into
 * src/db/migrations.generated.ts by scripts/build-migrations.mjs. This test fails when
 * a migration was added or edited without running that script.
 */
describe('bundled migrations', () => {
  const dir = join(__dirname, '..', '..', 'prisma', 'migrations');
  const onDisk = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  it('contain every migration in prisma/migrations, in order', () => {
    expect(MIGRATIONS.map((m) => m.name)).toEqual(onDisk);
  });

  it('carry exactly the SQL that is on disk', () => {
    for (const migration of MIGRATIONS) {
      const sql = readFileSync(join(dir, migration.name, 'migration.sql'), 'utf8');
      expect(migration.sql, migration.name).toBe(sql);
      expect(migration.checksum, migration.name).toBe(createHash('sha256').update(sql).digest('hex'));
    }
  });
});

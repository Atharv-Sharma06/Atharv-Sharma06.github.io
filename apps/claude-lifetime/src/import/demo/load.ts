import { ImportError } from '@/core/types';
import type { SqlDriver } from '@/db/driver';
import { commitImport } from '../commit';
import { asOnlyImport } from '../lock';
import { resetStaging, StagingWriter } from '../staging';
import { buildDemoDataset } from './generate';

export interface DemoLoadResult {
  conversations: number;
  messages: number;
  usageRows: number;
  costRows: number;
  /** False when the user already has subscription periods of their own, which are kept. */
  periodsAdded: boolean;
}

/**
 * Loads the synthetic demo dataset into an empty workspace. Refused as soon as any
 * real data exists: invented numbers are never mixed into a real history.
 */
export async function loadDemoDataset(db: SqlDriver, userId: number, timezone: string, now: Date = new Date()): Promise<DemoLoadResult> {
  const real = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM data_sources WHERE user_id = $1`, [userId]);
  if (real.rows[0].n > 0) {
    throw new ImportError(
      'The demo dataset can only be loaded into an empty workspace. Delete your imported data first, or keep working with your real data.',
      'demo_requires_empty_workspace',
    );
  }

  const dataset = buildDemoDataset(now);
  const result: DemoLoadResult = { conversations: 0, messages: 0, usageRows: 0, costRows: 0, periodsAdded: false };
  // The parts go through the shared staging tables like any import, so no other import may be under way.
  await asOnlyImport(async () => {
    for (const part of dataset.parts) {
      const staging = await resetStaging(db);
      const writer = new StagingWriter(db);
      await part.write(writer);
      await writer.finish();
      const committed = await commitImport(db, userId, part.parsed, { staging });
      result.conversations += committed.inserted.conversations;
      result.messages += committed.inserted.messages;
      result.usageRows += committed.inserted.usageRows;
      result.costRows += committed.inserted.costRows;
    }
    await resetStaging(db);
  });

  // Demo subscription periods are only added when the user has entered none of their own.
  const own = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM subscription_periods WHERE user_id = $1`, [userId]);
  if (own.rows[0].n === 0) {
    await db.transaction(async (tx) => {
      for (const p of dataset.periods) {
        await tx.query(
          `INSERT INTO subscription_periods (user_id, plan_key, start_date, last_date, monthly_price, currency, notes, is_synthetic)
           VALUES ($1, $2, $3::date, $4::date, $5::numeric, 'USD', 'Synthetic demo period', true)`,
          [userId, p.planKey, p.startDate, p.lastDate, p.monthlyPrice],
        );
      }
    });
    result.periodsAdded = true;
  }
  await db.flush();
  return result;
}

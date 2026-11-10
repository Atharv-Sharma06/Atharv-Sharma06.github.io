import type { SqlDriver } from '@/db/driver';
import { refreshConversationCounters } from './commit';

/**
 * Explicit data deletion. Everything imported is reachable from a data source and an
 * import batch through ON DELETE CASCADE foreign keys, so deleting either removes
 * every row it contributed and nothing else.
 */
export interface DeleteResult {
  deleted: boolean;
  /** Conversations removed because nothing was left in them. */
  conversationsRemoved: number;
}

/** Removes one import and every record it contributed. */
export async function deleteBatch(db: SqlDriver, userId: number, batchId: number): Promise<DeleteResult> {
  const result = await db.transaction(async (tx) => {
    const touched = await tx.query<{ id: number }>(
      `SELECT DISTINCT conversation_id AS id FROM messages WHERE batch_id = $1
       UNION SELECT DISTINCT conversation_id FROM usage_records WHERE batch_id = $1 AND conversation_id IS NOT NULL`,
      [batchId],
    );
    const ids = touched.rows.map((r) => r.id);
    const del = await tx.query(`DELETE FROM import_batches WHERE id = $1 AND user_id = $2`, [batchId, userId]);
    if ((del.affectedRows ?? 0) === 0) return { deleted: false, conversationsRemoved: 0 };

    const orphans = await tx.query(
      `DELETE FROM conversations c
        WHERE c.user_id = $1 AND c.id = ANY($2::int[])
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM usage_records u WHERE u.conversation_id = c.id)`,
      [userId, ids],
    );
    if (ids.length > 0) {
      await refreshConversationCounters(tx, userId, `c.id IN (${ids.map((n) => Number(n)).join(',')})`);
    }
    // A source with no imports left has nothing to show.
    await tx.query(
      `DELETE FROM data_sources s WHERE s.user_id = $1
          AND NOT EXISTS (SELECT 1 FROM import_batches b WHERE b.source_id = s.id)`,
      [userId],
    );
    return { deleted: true, conversationsRemoved: orphans.affectedRows ?? 0 };
  });
  await db.flush();
  return result;
}

/** Removes a data source with all of its imports, conversations and usage. */
export async function deleteSource(db: SqlDriver, userId: number, sourceId: number): Promise<DeleteResult> {
  const result = await db.transaction(async (tx) => {
    const conv = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM conversations WHERE source_id = $1 AND user_id = $2`, [sourceId, userId]);
    const del = await tx.query(`DELETE FROM data_sources WHERE id = $1 AND user_id = $2`, [sourceId, userId]);
    return { deleted: (del.affectedRows ?? 0) > 0, conversationsRemoved: conv.rows[0].n };
  });
  await db.flush();
  return result;
}

/**
 * Removes everything that was imported. Subscription history, settings and prices the
 * user entered are kept unless asked otherwise.
 */
export async function deleteAllData(
  db: SqlDriver,
  userId: number,
  options: { subscriptions?: boolean; customPrices?: boolean } = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(`DELETE FROM data_sources WHERE user_id = $1`, [userId]);
    if (options.subscriptions) await tx.query(`DELETE FROM subscription_periods WHERE user_id = $1`, [userId]);
    else await tx.query(`DELETE FROM subscription_periods WHERE user_id = $1 AND is_synthetic`, [userId]);
    if (options.customPrices) await tx.query(`DELETE FROM pricing_history WHERE NOT is_builtin`);
    // Model identifiers that only existed because of imported data.
    await tx.query(
      `DELETE FROM model_catalog m WHERE NOT m.is_builtin
          AND NOT EXISTS (SELECT 1 FROM pricing_history p WHERE p.model_id = m.id)`,
    );
  });
  // Give the space back; VACUUM cannot run inside a transaction.
  await db.exec('VACUUM FULL;');
  await db.flush();
}

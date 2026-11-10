import type { SqlDriver, SqlExecutor } from '@/db/driver';
import { refreshStatistics } from '@/db/maintenance';
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
    const del = await tx.query<{ source_id: number }>(`DELETE FROM import_batches WHERE id = $1 AND user_id = $2 RETURNING source_id`, [batchId, userId]);
    if (del.rows.length === 0) return { deleted: false, conversationsRemoved: 0 };
    // The source's files are no longer "already read": some of what they held was just
    // deleted. The next sync reads them again; requests that other imports still hold
    // are recognised by their keys and are not counted twice.
    await tx.query(`DELETE FROM synced_files WHERE source_id = $1`, [del.rows[0].source_id]);

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
    // A source with no imports left has nothing to show. Conversations it started that another source
    // has added to are handed to that source first, so they are not removed along with it.
    const empty = await tx.query<{ id: number }>(
      `SELECT s.id FROM data_sources s WHERE s.user_id = $1 AND NOT EXISTS (SELECT 1 FROM import_batches b WHERE b.source_id = s.id)`,
      [userId],
    );
    for (const source of empty.rows) {
      await handOverSharedConversations(tx, userId, source.id);
      await tx.query(`DELETE FROM data_sources WHERE id = $1 AND user_id = $2`, [source.id, userId]);
    }
    await removeOrphanedDemoPeriods(tx, userId);
    return { deleted: true, conversationsRemoved: orphans.affectedRows ?? 0 };
  });
  if (result.deleted) await refreshStatistics(db);
  await db.flush();
  return result;
}

/** Removes a data source with all of its imports, conversations and usage. */
export async function deleteSource(db: SqlDriver, userId: number, sourceId: number): Promise<DeleteResult> {
  const result = await db.transaction(async (tx) => {
    // Conversations of other sources that this source added records to lose those records, and nothing else.
    const visited = await tx.query<{ id: number }>(
      `SELECT c.id FROM conversations c
        WHERE c.user_id = $1 AND c.source_id <> $2
          AND (EXISTS (SELECT 1 FROM usage_records u WHERE u.conversation_id = c.id AND u.source_id = $2)
            OR EXISTS (SELECT 1 FROM messages m JOIN import_batches b ON b.id = m.batch_id WHERE m.conversation_id = c.id AND b.source_id = $2))`,
      [userId, sourceId],
    );
    // Conversations this source started that another source has added to stay, with that source's records.
    const kept = await handOverSharedConversations(tx, userId, sourceId);
    const conv = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM conversations WHERE source_id = $1 AND user_id = $2`, [sourceId, userId]);
    const del = await tx.query(`DELETE FROM data_sources WHERE id = $1 AND user_id = $2`, [sourceId, userId]);
    const touched = [...visited.rows.map((r) => r.id), ...kept];
    if (touched.length > 0) {
      await tx.query(
        `DELETE FROM conversations c
          WHERE c.user_id = $1 AND c.id = ANY($2::int[])
            AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
            AND NOT EXISTS (SELECT 1 FROM usage_records u WHERE u.conversation_id = c.id)`,
        [userId, touched],
      );
      await refreshConversationCounters(tx, userId, `c.id IN (${touched.map((n) => Number(n)).join(',')})`);
    }
    await removeOrphanedDemoPeriods(tx, userId);
    return { deleted: (del.affectedRows ?? 0) > 0, conversationsRemoved: conv.rows[0].n };
  });
  if (result.deleted) await refreshStatistics(db);
  await db.flush();
  return result;
}

/**
 * A conversation belongs to the source that imported it first, but another source can
 * add records to it later: the same Claude Code session read under two computer names,
 * or one claude.ai account imported with and without its account id. Before a source
 * is removed, the conversations it started that hold records of another source are
 * handed to that source. Left alone, they would be deleted with their source and take
 * the other source's records with them. Returns the conversations that were handed over.
 */
async function handOverSharedConversations(tx: SqlExecutor, userId: number, sourceId: number): Promise<number[]> {
  const { rows } = await tx.query<{ id: number }>(
    `UPDATE conversations c SET source_id = keep.source_id
       FROM (
         SELECT mine.id,
                (SELECT min(other.source_id) FROM (
                   SELECT u.source_id FROM usage_records u WHERE u.conversation_id = mine.id AND u.source_id <> $2
                   UNION ALL
                   SELECT b.source_id FROM messages m JOIN import_batches b ON b.id = m.batch_id WHERE m.conversation_id = mine.id AND b.source_id <> $2
                 ) other) AS source_id
           FROM conversations mine WHERE mine.user_id = $1 AND mine.source_id = $2
       ) keep
      WHERE c.id = keep.id AND keep.source_id IS NOT NULL
      RETURNING c.id`,
    [userId, sourceId],
  );
  return rows.map((r) => r.id);
}

/**
 * The demo's subscription periods belong to the demo data. When the last synthetic
 * source is gone they go too, so no invented plan history is left behind next to
 * nothing, or next to real data imported later.
 */
async function removeOrphanedDemoPeriods(tx: SqlExecutor, userId: number): Promise<void> {
  await tx.query(
    `DELETE FROM subscription_periods p
      WHERE p.user_id = $1 AND p.is_synthetic
        AND NOT EXISTS (SELECT 1 FROM data_sources s WHERE s.user_id = $1 AND s.is_synthetic)`,
    [userId],
  );
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
  // Give the space back and refresh the planner's statistics; VACUUM cannot run inside a transaction.
  await db.exec('VACUUM (FULL, ANALYZE);');
  await db.flush();
}

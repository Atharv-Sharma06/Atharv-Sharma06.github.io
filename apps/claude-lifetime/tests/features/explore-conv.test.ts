import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { loadDemoDataset } from '@/import/demo/load';
import { createTestDb, type TestDb } from '../helpers/db';

const NOW = new Date('2026-11-10T12:00:00Z');
let t: TestDb;
const OUT: string[] = [];
beforeAll(async () => {
  t = await createTestDb('UTC');
  await loadDemoDataset(t.db, t.userId, 'UTC', NOW);
});
afterAll(async () => {
  writeFileSync('/tmp/claude-0/-home-user/bb0dfdd4-dd86-5a48-a206-6d561655db66/scratchpad/conv-work/explore2.txt', OUT.join('\n'));
  await t.close();
});

describe('explore', () => {
  it('prints', async () => {
    const q = async (label: string, sql: string) => {
      const { rows } = await t.db.query(sql);
      OUT.push(label + ' ' + JSON.stringify(rows));
    };
    await q('multi-model sessions', `SELECT c.id, c.title, count(DISTINCT u.model_id) AS models, sum(u.input_tokens+u.output_tokens+u.cache_read_tokens+u.cache_write_5m_tokens+u.cache_write_1h_tokens)::bigint AS tok FROM conversations c JOIN usage_records u ON u.conversation_id = c.id GROUP BY 1,2 HAVING count(DISTINCT u.model_id) > 1 ORDER BY tok DESC LIMIT 5`);
    await q('multi-day sessions', `SELECT c.id, c.title, count(DISTINCT (u.occurred_at AT TIME ZONE 'UTC')::date) AS days FROM conversations c JOIN usage_records u ON u.conversation_id = c.id GROUP BY 1,2 HAVING count(DISTINCT (u.occurred_at AT TIME ZONE 'UTC')::date) > 1 ORDER BY days DESC LIMIT 5`);
    await q('single-turn chats', `SELECT c.id, c.title, c.message_count FROM conversations c WHERE c.kind = 'chat' AND c.message_count = 2 ORDER BY c.id LIMIT 3`);
    await q('multi-method chats', `SELECT c.id, c.title, count(DISTINCT e.method_id) AS methods FROM conversations c JOIN token_estimates e ON e.conversation_id = c.id GROUP BY 1,2 HAVING count(DISTINCT e.method_id) > 1 LIMIT 5`);
    await q('methods used', `SELECT m.method_key, count(*) FROM token_estimates e JOIN estimation_methods m ON m.id = e.method_id GROUP BY 1`);
    await q('untitled', `SELECT count(*) FROM conversations WHERE title IS NULL OR title = ''`);
    await q('kinds', `SELECT kind, count(*) FROM conversations GROUP BY 1`);
    await q('recent chat', `SELECT c.id, c.title, c.created_at, c.message_count FROM conversations c WHERE c.kind='chat' ORDER BY c.created_at DESC LIMIT 3`);
    await q('multi-day chats', `SELECT c.id, c.title, c.message_count, c.created_at, c.updated_at FROM conversations c WHERE c.kind='chat' AND (c.updated_at AT TIME ZONE 'UTC')::date > (c.created_at AT TIME ZONE 'UTC')::date ORDER BY c.message_count DESC LIMIT 3`);
  });
});

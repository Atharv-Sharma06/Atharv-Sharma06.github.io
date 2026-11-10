import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ImportParser } from '@/core/types';
import { commitImport, previewImport } from '@/import/commit';
import { deleteBatch } from '@/import/delete';
import { genericCsvParser, genericJsonParser } from '@/import/generic';
import { resetStaging, StagingWriter } from '@/import/staging';
import { createTestDb, type TestDb } from '../helpers/db';
import { fileOf } from '../helpers/sink';

/**
 * A custom CSV or JSON file has no ids for its rows unless it brings some, so a row is
 * known by what was read from it. The same file imported into the same source again,
 * with other columns or settings, must take the place of its earlier import: added
 * next to it, every row that reads differently would be counted twice.
 */
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());
beforeEach(() => t.reset());

const NOW = Date.UTC(2026, 10, 10);

async function importWith(parser: ImportParser, name: string, content: string, options: Record<string, unknown> = {}) {
  await resetStaging(t.db);
  const writer = new StagingWriter(t.db);
  const parsed = await parser.parse([fileOf(name, content)], writer, { options: { now: NOW, ...options } });
  await writer.finish();
  const preview = await previewImport(t.db, t.userId, parsed);
  const result = await commitImport(t.db, t.userId, parsed);
  return { parsed, preview, result };
}

const rows = async <T = Record<string, unknown>>(sql: string) => (await t.db.query<T>(sql)).rows;
const totals = async () =>
  (
    await rows<{ rows: number; input: number; output: number; cache_read: number }>(
      `SELECT count(*)::int AS rows, sum(input_tokens)::int AS input, sum(output_tokens)::int AS output, sum(cache_read_tokens)::int AS cache_read FROM usage_records`,
    )
  )[0];
const history = () =>
  rows<{ file_name: string; records_inserted: number; notes: string | null }>(
    `SELECT file_name, records_inserted,
            (SELECT string_agg((w->>'code') || ':' || (w->>'count'), ',' ORDER BY w->>'code') FROM jsonb_array_elements(warnings) w
              WHERE w->>'code' IN ('superseded', 'replaced_earlier')) AS notes
       FROM import_batches ORDER BY id`,
  );

// A table as a logging proxy might write it. "cached" is not a name the importer recognises by itself.
const PROXY = ['day,model,input_tokens,output_tokens,cached', '2026-03-01,claude-sonnet-4-6,1000,100,8000', '2026-03-02,claude-sonnet-4-6,2000,200,9000', '2026-03-03,claude-sonnet-4-6,3000,300,0'].join('\n') + '\n';
const SOURCE = { sourceLabel: 'Proxy log', sourceRef: 'proxy-log' };
const WITH_CACHE = { timestamp: 'day', model: 'model', input_tokens: 'input_tokens', output_tokens: 'output_tokens', cache_read_tokens: 'cached' };

describe('the same file imported into the same source again', () => {
  it('with another column mapping: replaces the rows that read differently instead of adding them', async () => {
    await importWith(genericCsvParser, 'proxy.csv', PROXY, { ...SOURCE, confidence: 'exact' });
    expect(await totals()).toEqual({ rows: 3, input: 6000, output: 600, cache_read: 0 });

    // the same file, the same source; this time "cached" is read as cache read tokens
    const second = await importWith(genericCsvParser, 'proxy.csv', PROXY, { ...SOURCE, confidence: 'exact', mapping: WITH_CACHE });
    expect(second.preview.previousImport).toMatchObject({ sameSource: true });
    // the row of 3 March has no cached tokens and reads as before; the other two do not
    expect(second.preview.usageRows).toMatchObject({ total: 3, new: 2, duplicate: 1 });
    expect(second.preview).toMatchObject({ rereadsEarlierImport: true, replaced: { usageRows: 2, costRows: 0, tokens: 3300 }, nothingNew: false });
    expect(second.result).toMatchObject({ replaced: { usageRows: 2 }, inserted: { usageRows: 2 } });
    // what the file says, once
    expect(await totals()).toEqual({ rows: 3, input: 6000, output: 600, cache_read: 17000 });
    expect(await history()).toEqual([
      { file_name: 'proxy.csv', records_inserted: 1, notes: 'superseded:2' },
      { file_name: 'proxy.csv', records_inserted: 2, notes: 'replaced_earlier:2' },
    ]);

    // read the same way a third time: nothing to do
    const third = await importWith(genericCsvParser, 'proxy.csv', PROXY, { ...SOURCE, confidence: 'exact', mapping: WITH_CACHE });
    expect(third.preview).toMatchObject({ nothingNew: true, rereadsEarlierImport: false });
    expect(third.result.nothingNew).toBe(true);
    expect(await totals()).toEqual({ rows: 3, input: 6000, output: 600, cache_read: 17000 });
  });

  it('with a price tier column mapped the second time: one row, under the tier it is read with now', async () => {
    const withTier = ['day,model,input_tokens,output_tokens,kind', '2026-03-01,claude-sonnet-4-6,1000,100,batch'].join('\n') + '\n';
    await importWith(genericCsvParser, 'tiers.csv', withTier);
    await importWith(genericCsvParser, 'tiers.csv', withTier, { mapping: { timestamp: 'day', model: 'model', input_tokens: 'input_tokens', output_tokens: 'output_tokens', price_tier: 'kind' } });
    expect(await rows(`SELECT price_tier, input_tokens::int AS input FROM usage_records ORDER BY price_tier`)).toEqual([{ price_tier: 'batch', input: 1000 }]);
    // the first import has nothing left and is gone from the history
    expect((await history()).map((b) => [b.file_name, b.records_inserted, b.notes])).toEqual([['tiers.csv', 1, 'replaced_earlier:1']]);
  });

  it('declared exact the second time: rows that have ids are stored as exact, not left as estimates', async () => {
    const withIds = ['id,day,model,input_tokens,output_tokens', 'r1,2026-03-01,claude-sonnet-4-6,1000,100', 'r2,2026-03-02,claude-sonnet-4-6,2000,200'].join('\n') + '\n';
    const first = await importWith(genericCsvParser, 'metered.csv', withIds);
    expect(first.preview.tokens).toEqual({ exact: 0, estimated: 3300 });

    const second = await importWith(genericCsvParser, 'metered.csv', withIds, { confidence: 'exact' });
    expect(second.preview).toMatchObject({ rereadsEarlierImport: true, replaced: { usageRows: 2 }, tokens: { exact: 3300, estimated: 0 } });
    expect(await rows(`SELECT confidence::text AS confidence, count(*)::int AS n, sum(input_tokens)::int AS input FROM usage_records GROUP BY 1`)).toEqual([
      { confidence: 'exact', n: 2, input: 3000 },
    ]);

    // the same for a JSON file, whose records have no column mapping at all
    const json = JSON.stringify({ format: 'claude-lifetime/usage', version: 1, source: { label: 'Gateway', ref: 'gw-1' }, records: [{ timestamp: '2026-03-05T10:00:00Z', model: 'claude-sonnet-4-6', input_tokens: 500, output_tokens: 50 }] });
    await importWith(genericJsonParser, 'gateway.json', json);
    const again = await importWith(genericJsonParser, 'gateway.json', json, { confidence: 'exact' });
    expect(again.preview).toMatchObject({ rereadsEarlierImport: true, replaced: { usageRows: 1 } });
    expect(await rows(`SELECT confidence::text AS confidence, sum(input_tokens)::int AS input FROM usage_records u JOIN data_sources s ON s.id = u.source_id WHERE s.external_ref = 'gw-1' GROUP BY 1`)).toEqual([
      { confidence: 'exact', input: 500 },
    ]);
  });

  it('removes a conversation that only the replaced rows belonged to, and keeps the others counted right', async () => {
    const withChats = ['day,model,input_tokens,output_tokens,chat', '2026-03-01,claude-sonnet-4-6,1000,100,chat-a', '2026-03-02,claude-sonnet-4-6,2000,200,chat-b'].join('\n') + '\n';
    const base = { timestamp: 'day', model: 'model', input_tokens: 'input_tokens', output_tokens: 'output_tokens' };
    await importWith(genericCsvParser, 'chats.csv', withChats, { mapping: { ...base, conversation_id: 'chat' } });
    expect(await rows(`SELECT external_id FROM conversations ORDER BY 1`)).toEqual([{ external_id: 'chat-a' }, { external_id: 'chat-b' }]);

    // read again without the conversation column: the rows stay, their conversations do not
    await importWith(genericCsvParser, 'chats.csv', withChats, { mapping: base });
    expect(await rows(`SELECT external_id FROM conversations`)).toEqual([]);
    expect(await totals()).toMatchObject({ rows: 2, input: 3000 });
    expect(await rows(`SELECT count(*)::int AS n FROM usage_records WHERE conversation_id IS NOT NULL`)).toEqual([{ n: 0 }]);
  });

  it('leaves other files and other sources alone', async () => {
    await importWith(genericCsvParser, 'proxy.csv', PROXY, SOURCE);
    // a longer version of the table is another file: only its new row is added
    const longer = `${PROXY}2026-03-04,claude-sonnet-4-6,4000,400,0\n`;
    const grown = await importWith(genericCsvParser, 'proxy.csv', longer, SOURCE);
    expect(grown.preview).toMatchObject({ rereadsEarlierImport: false, replaced: null, usageRows: { new: 1, duplicate: 3 } });
    expect(await totals()).toMatchObject({ rows: 4, input: 10_000 });

    // the same file under another source is not a second reading of this source's import
    const elsewhere = await importWith(genericCsvParser, 'proxy.csv', PROXY, { sourceLabel: 'Other proxy', sourceRef: 'other-proxy', mapping: WITH_CACHE });
    expect(elsewhere.preview).toMatchObject({ rereadsEarlierImport: false, replaced: null, previousImport: { sameSource: false } });
    expect(await totals()).toMatchObject({ rows: 7, input: 16_000 });

    // and deleting the second reading of a file takes away what it stored, no more
    const reread = await importWith(genericCsvParser, 'proxy.csv', PROXY, { ...SOURCE, mapping: WITH_CACHE });
    expect(reread.result.replaced.usageRows).toBe(2);
    expect(await totals()).toMatchObject({ rows: 7, input: 16_000 });
    await deleteBatch(t.db, t.userId, reread.result.batchId!);
    // the two rows it replaced do not come back (the history said so), the rest stays
    expect(await totals()).toMatchObject({ rows: 5, input: 13_000 });
  });
});

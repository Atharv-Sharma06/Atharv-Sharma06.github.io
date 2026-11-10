import { describe, expect, it } from 'vitest';
import { savedSentence } from '@/features/import/wizard';
import type { CommitResult } from '@/import/commit';

/**
 * The sentence that closes an import. It has to say what the save did, also when
 * the save added nothing: a report that no longer lists rows which are stored takes
 * those rows away, and "Added from report.json." would say the opposite.
 */
const result = (over: Partial<CommitResult> = {}): CommitResult => ({
  batchId: 7,
  sourceId: 3,
  inserted: { conversations: 0, messages: 0, usageRows: 0, costRows: 0 },
  duplicates: { messages: 0, usageRows: 0, costRows: 0 },
  replaced: { usageRows: 0, costRows: 0 },
  removedDemoData: false,
  nothingNew: false,
  ...over,
});

describe('the sentence that closes an import', () => {
  it('names what was added, each kind once and in words that fit the number', () => {
    expect(savedSentence(result({ inserted: { conversations: 2, messages: 31, usageRows: 0, costRows: 0 } }), 'conversations.json')).toBe(
      'Added 2 conversations and 31 messages from conversations.json.',
    );
    expect(savedSentence(result({ inserted: { conversations: 1, messages: 1, usageRows: 1, costRows: 1 } }), 'all.json')).toBe(
      'Added 1 conversation, 1 message, 1 usage row, and 1 cost row from all.json.',
    );
    expect(savedSentence(result({ inserted: { conversations: 0, messages: 0, usageRows: 1200, costRows: 0 } }), 'usage.csv')).toBe('Added 1,200 usage rows from usage.csv.');
  });

  it('says that nothing was added when the file held nothing new', () => {
    expect(savedSentence(result({ batchId: null, nothingNew: true, duplicates: { messages: 31, usageRows: 0, costRows: 0 } }), 'conversations.json')).toBe(
      'The file held nothing new, so no records were added.',
    );
  });

  it('says that stored rows were removed when that is all the import did', () => {
    // A report that restates a period and no longer lists some of its rows: nothing to add, and the stored rows go.
    expect(savedSentence(result({ replaced: { usageRows: 3, costRows: 0 } }), 'usage-report.json')).toBe(
      'Removed 3 stored rows that usage-report.json no longer lists. It held no rows that were not stored already.',
    );
    expect(savedSentence(result({ replaced: { usageRows: 0, costRows: 1 } }), 'cost-report.json')).toBe(
      'Removed 1 stored row that cost-report.json no longer lists. It held no rows that were not stored already.',
    );
  });

  it('never claims an addition that did not happen', () => {
    for (const r of [result(), result({ nothingNew: true }), result({ replaced: { usageRows: 2, costRows: 2 } })]) {
      expect(savedSentence(r, 'file.json')).not.toMatch(/^Added/);
    }
    expect(savedSentence(result(), 'file.json')).toBe('Nothing was added from file.json: what it holds was stored already.');
  });

  it('still names the additions when stored rows were replaced as well', () => {
    expect(savedSentence(result({ inserted: { conversations: 0, messages: 0, usageRows: 24, costRows: 0 }, replaced: { usageRows: 24, costRows: 0 } }), 'usage.json')).toBe(
      'Added 24 usage rows from usage.json.',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { ImportError, type ImportFile } from '@/core/types';
import { apiUsageReportParser } from '@/import/api-reports';
import { claudeCodeParser } from '@/import/claude-code';
import { detectImport } from '@/import/detect';
import { genericJsonParser } from '@/import/generic';
import { assistant, at, fixtureText, jsonl, LATER, usage as tokens, user } from '../fixtures/claude-code/builders';
import { collectingSink, fileOf } from '../helpers/sink';

/**
 * Format detection for selections that the file names alone get wrong: a transcript
 * whose first line is longer than the part of a file that is read first, and several
 * files selected together. Contents are real: what detection accepts is handed to the
 * parser it names.
 */
const HEAD_BYTES = 256 * 1024;

type Outcome = { parser: string; recognisedAs: string; fileIndexes: number[]; ignoredFiles: number; totalBytes: number } | { error: string; message: string };
const outcome = async (files: ImportFile[]): Promise<Outcome> => {
  try {
    const d = await detectImport(files);
    return { parser: d.parser, recognisedAs: d.recognisedAs, fileIndexes: d.fileIndexes, ignoredFiles: d.ignoredFiles, totalBytes: d.totalBytes };
  } catch (error) {
    if (error instanceof ImportError) return { error: error.code, message: error.message };
    throw error;
  }
};

/** A session transcript: a typed prompt and `responses` answers with usage. */
const transcript = (session: string, responses = 2, prompt: unknown = 'please do the thing') =>
  jsonl([
    user(prompt, { ts: at('09:00:00'), session }),
    ...Array.from({ length: responses }, (_, i) =>
      assistant({ ts: at(`09:00:0${i + 1}`), session, id: `msg_${session}_${i}`, req: `req_${session}_${i}`, usage: tokens(100, 50) }),
    ),
  ]);

/** A prompt that begins with a pasted screenshot: Claude Code stores the image inline, as base64. */
const withImage = (chars: number) => [
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(chars) } },
  { type: 'text', text: 'what is wrong here?' },
];

const usageLines = (tag: string, records = 3) =>
  jsonl(
    Array.from({ length: records }, (_, i) => ({
      timestamp: `2026-03-01T0${i + 1}:00:00Z`,
      model: 'claude-sonnet-4-6',
      input_tokens: 100 * (i + 1),
      output_tokens: 10,
      id: `${tag}-${i}`,
    })),
  );

const reportPage = (day: number, buckets = 1) => ({
  data: Array.from({ length: buckets }, (_, i) => ({
    starting_at: new Date(Date.UTC(2026, 0, day) + i * 60_000).toISOString(),
    ending_at: new Date(Date.UTC(2026, 0, day) + (i + 1) * 60_000).toISOString(),
    results: [{ uncached_input_tokens: 5, output_tokens: 1, model: 'claude-sonnet-4-6' }],
  })),
  has_more: false,
  next_page: null,
});

/** The same file, with a count of what detection reads from it. */
function counted(file: ImportFile, reads: { files: Set<string>; bytes: number; whole: number }): ImportFile {
  const blob = file.blob;
  const touch = () => reads.files.add(file.path ?? file.name);
  const watched = {
    size: blob.size,
    type: blob.type,
    slice(start?: number, end?: number) {
      touch();
      const part = blob.slice(start, end);
      reads.bytes += part.size;
      return part;
    },
    text() {
      touch();
      reads.whole++;
      return blob.text();
    },
    arrayBuffer() {
      touch();
      reads.whole++;
      return blob.arrayBuffer();
    },
    stream() {
      touch();
      reads.whole++;
      return blob.stream();
    },
  };
  return { ...file, blob: watched as unknown as Blob };
}
const noReads = () => ({ files: new Set<string>(), bytes: 0, whole: 0 });

describe('a JSON Lines file whose first line is longer than the part that is read first', () => {
  const long = transcript('s1', 2, withImage(400_000));

  it('is recognised as a Claude Code transcript when it is chosen on its own', async () => {
    expect(long.indexOf('\n')).toBeGreaterThan(HEAD_BYTES);
    expect(await outcome([fileOf('0b1f5c1e-5a5e-4b61-9d0a-6f2f0e3f9a11.jsonl', long)])).toMatchObject({
      parser: 'claude-code',
      recognisedAs: 'Claude Code session transcript',
      fileIndexes: [0],
      ignoredFiles: 0,
    });
  });

  it('and so is a remembered folder that holds only this transcript', async () => {
    // The background sync detects by content when the folder has one file.
    expect(await outcome([fileOf('s1.jsonl', long, { path: 'projects/-home-alex-demo/s1.jsonl' })])).toMatchObject({ parser: 'claude-code' });
  });

  it('the parser reads that file to the end, long line included', async () => {
    const { sink, out } = collectingSink();
    const parsed = await claudeCodeParser.parse([fileOf('s1.jsonl', long, { lastModified: Date.UTC(2026, 0, 15) })], sink, { options: { now: LATER } });
    expect(out.usage.reduce((n, u) => n + u.requestCount, 0)).toBe(2);
    expect(out.usage.reduce((n, u) => n + u.userMessageCount, 0)).toBe(1);
    expect(parsed.warnings.map((w) => w.code)).not.toContain('malformed_lines');
  });

  it('is read to the end of that line and no further', async () => {
    // Three megabytes of further rows follow the long first one.
    const big = long + transcript('s1', 9).repeat(1500);
    expect(big.length).toBeGreaterThan(3_000_000);
    const reads = noReads();
    expect(await outcome([counted(fileOf('s1.jsonl', big), reads)])).toMatchObject({ parser: 'claude-code' });
    expect(reads.whole).toBe(0);
    expect(reads.bytes).toBeLessThan(HEAD_BYTES + 1024 * 1024 + 1);
  });

  it('is told apart by what the line holds, not by the name: usage records and report pages are recognised as such', async () => {
    const records = jsonl([
      { timestamp: '2026-03-01T01:00:00Z', model: 'claude-sonnet-4-6', input_tokens: 100, output_tokens: 10, id: 'r-0', conversation_title: 'x'.repeat(300_000) },
      { timestamp: '2026-03-01T02:00:00Z', model: 'claude-sonnet-4-6', input_tokens: 200, output_tokens: 10, id: 'r-1' },
    ]);
    expect(await outcome([fileOf('usage.jsonl', records)])).toMatchObject({
      parser: 'generic-json',
      recognisedAs: 'JSON Lines file with usage records in the Claude Lifetime format',
    });

    // One page of a report per line, each page with a few thousand time buckets.
    const pages = jsonl([reportPage(1, 2500), reportPage(3, 2500)]);
    expect(pages.indexOf('\n')).toBeGreaterThan(HEAD_BYTES);
    const file = fileOf('usage-report.ndjson', pages);
    expect(await outcome([file])).toMatchObject({ parser: 'api-usage', recognisedAs: 'JSON Lines file with an Anthropic API usage report' });
    const { sink, out } = collectingSink();
    await apiUsageReportParser.parse([file], sink, {});
    expect(out.usage.length).toBeGreaterThan(0);
  });

  it('passes for a transcript by its name when the line cannot be read as JSON, because the parser skips such a line', async () => {
    const damaged = `{"type":"user","message":"${'A'.repeat(300_000)}\n${transcript('s1')}`;
    expect(await outcome([fileOf('s1.jsonl', damaged)])).toMatchObject({ parser: 'claude-code', recognisedAs: 'Claude Code session transcript' });
    // Without a transcript's name there is nothing to go by, and the message says what is wrong with the file.
    const result = await outcome([fileOf('rows.ndjson', damaged)]);
    expect(result).toMatchObject({ error: 'unknown_format' });
    expect((result as { message: string }).message).toMatch(/^The first line of "rows\.ndjson" could not be read as JSON, so the app cannot tell what the file holds\./);
  });

  it('leaves single JSON documents as they were, whatever their name', async () => {
    // Pretty-printed: the first line is "{" and ends inside the head, so the document is parsed whole.
    const pretty = JSON.stringify(reportPage(1, 2500), null, 2);
    expect(pretty.length).toBeGreaterThan(HEAD_BYTES);
    expect(await outcome([fileOf('report.jsonl', pretty)])).toMatchObject({ parser: 'api-usage', recognisedAs: 'JSON file with an Anthropic API usage report' });
    // Compact, on one line without a line break: longer than the head, and still one document.
    const compact = JSON.stringify(reportPage(1, 2500));
    expect(compact.length).toBeGreaterThan(HEAD_BYTES);
    expect(await outcome([fileOf('report.json', compact)])).toMatchObject({ parser: 'api-usage', recognisedAs: 'JSON file with an Anthropic API usage report' });
    expect(await outcome([fileOf('report.jsonl', compact)])).toMatchObject({ parser: 'api-usage' });
    // A document that is cut off is still reported as such.
    const cut = await outcome([fileOf('report.json', compact.slice(0, 300_000))]);
    expect(cut).toMatchObject({ error: 'unknown_format' });
    expect((cut as { message: string }).message).toMatch(/starts like a JSON document but cannot be parsed/);
  });
});

describe('several files selected together', () => {
  it('reads JSON Lines usage files as usage files, not as a Claude Code folder', async () => {
    const files = [fileOf('usage-march-1.jsonl', usageLines('a')), fileOf('usage-march-2.jsonl', usageLines('b'))];
    expect(await outcome(files)).toMatchObject({
      parser: 'generic-json',
      recognisedAs: '2 files: JSON Lines file with usage records in the Claude Lifetime format',
      fileIndexes: [0, 1],
      ignoredFiles: 0,
    });
    const { sink, out } = collectingSink();
    await genericJsonParser.parse(files, sink, {});
    expect(out.usage).toHaveLength(6);
  });

  it('reads report pages kept one per line together with pages kept one per file', async () => {
    const files = [fileOf('pages-1-2.jsonl', jsonl([reportPage(1), reportPage(2)])), fileOf('page-3.json', JSON.stringify(reportPage(3)))];
    expect(await outcome(files)).toMatchObject({ parser: 'api-usage', fileIndexes: [0, 1], ignoredFiles: 0 });
  });

  it('reports the files next to a transcript that the Claude Code parser will not read', async () => {
    const files = [
      fileOf('page-1.json', JSON.stringify(reportPage(1))),
      fileOf('page-2.json', JSON.stringify(reportPage(2))),
      fileOf('session.jsonl', transcript('s1', 1)),
    ];
    expect(await outcome(files)).toEqual({
      parser: 'claude-code',
      recognisedAs: '1 Claude Code transcript file',
      fileIndexes: [2],
      ignoredFiles: 2,
      totalBytes: files[2].size,
    });
  });

  it('does not hand a usage file to the Claude Code parser because it is selected with transcripts', async () => {
    const files = [fileOf('s1.jsonl', transcript('s1')), fileOf('usage.jsonl', usageLines('a')), fileOf('s2.jsonl', transcript('s2'))];
    expect(await outcome(files)).toMatchObject({ parser: 'claude-code', recognisedAs: '2 Claude Code transcript files', fileIndexes: [0, 2], ignoredFiles: 1 });
  });

  it('accepts transcripts that were picked one by one, as the import page offers', async () => {
    const main = 'research-example/projects/-home-alex-demo/11111111-1111-4111-8111-111111111111';
    const files = [fileOf('11111111-1111-4111-8111-111111111111.jsonl', fixtureText(`${main}.jsonl`)), fileOf('agent-a0000000000000001.jsonl', fixtureText(`${main}/subagents/agent-a0000000000000001.jsonl`))];
    expect(await outcome(files)).toMatchObject({ parser: 'claude-code', recognisedAs: '2 Claude Code transcript files', fileIndexes: [0, 1], ignoredFiles: 0 });
  });

  it('still goes by the names when no .jsonl file can be recognised, as for a single such file', async () => {
    const unknown = '{"messages":[{"role":"user","content":"hi"}]}\n{"messages":[]}\n';
    expect(await outcome([fileOf('finetune.jsonl', unknown)])).toMatchObject({ parser: 'claude-code', recognisedAs: 'Claude Code session transcript' });
    expect(await outcome([fileOf('a.jsonl', unknown), fileOf('b.jsonl', unknown), fileOf('empty.jsonl', '')])).toMatchObject({
      parser: 'claude-code',
      recognisedAs: '3 Claude Code transcript files',
      fileIndexes: [0, 1, 2],
    });
  });

  it('keeps refusing transcripts together with a claude.ai export, and names usage files next to an export as different kinds', async () => {
    const conversations = fileOf('conversations.json', fixtureExport());
    const mixed = await outcome([fileOf('s1.jsonl', transcript('s1')), conversations]);
    expect(mixed).toMatchObject({ error: 'mixed_selection' });
    expect((mixed as { message: string }).message).toMatch(/^This selection contains both Claude Code transcripts and a claude\.ai export\./);

    const other = await outcome([fileOf('usage.jsonl', usageLines('a')), conversations]);
    expect(other).toMatchObject({ error: 'mixed_selection' });
    expect((other as { message: string }).message).toMatch(/^The selected files are of different kinds\./);
  });
});

describe('a Claude Code folder', () => {
  /** What dropping a .claude folder on the page hands over: transcripts below projects/, and whatever else lies there. */
  function folder(transcripts: number, reads = noReads()): { files: ImportFile[]; reads: ReturnType<typeof noReads> } {
    const add = (path: string, content: string) => counted(fileOf(path.split('/').pop() ?? path, content, { path }), reads);
    const files: ImportFile[] = [
      add('.claude/history.jsonl', jsonl([{ display: 'fix the test', pastedContents: {}, timestamp: 1_768_000_000_000, project: '/home/alex/demo' }])),
      add('.claude/settings.json', '{"theme":"dark"}'),
      add('.claude/todos/list.json', '[]'),
    ];
    const content = transcript('s1');
    for (let i = 0; i < transcripts; i++) {
      const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
      files.push(add(`.claude/projects/-home-alex-project-${i % 40}/${id}.jsonl`, content));
    }
    return { files, reads };
  }

  it('with thousands of transcripts is recognised from a handful of them', async () => {
    const { files, reads } = folder(5000);
    const result = await outcome(files);
    expect(result).toMatchObject({ parser: 'claude-code', recognisedAs: 'folder with 5,001 Claude Code transcript files', ignoredFiles: 2 });
    // Every .jsonl file goes to the parser, which decides row by row; the two .json files do not.
    expect((result as { fileIndexes: number[] }).fileIndexes).toEqual([0, ...Array.from({ length: 5000 }, (_, i) => i + 3)]);
    expect(reads.files.size).toBeLessThanOrEqual(20);
    expect(reads.whole).toBe(0);
  });

  it('is recognised when the other .jsonl files in it outnumber the transcripts', async () => {
    const { files } = folder(3);
    for (let i = 0; i < 60; i++) files.push(fileOf(`log-${i}.jsonl`, usageLines(`log-${i}`), { path: `.claude/usage-logs/log-${i}.jsonl` }));
    expect(await outcome(files)).toMatchObject({ parser: 'claude-code' });
  });

  it('is not held up by a .jsonl file that cannot be read', async () => {
    const { files } = folder(2);
    // The first bytes of a ZIP archive, and nothing after them.
    files.push(fileOf('broken.jsonl', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]), { path: '.claude/projects/-home-alex-project-0/broken.jsonl' }));
    expect(await outcome(files)).toMatchObject({ parser: 'claude-code', recognisedAs: 'folder with 4 Claude Code transcript files' });
  });

  it('has every transcript read, also one whose text holds a pattern that suggests another format', async () => {
    // The marker of a collector ledger, in the structured result of a tool call. It only makes a file a ledger where
    // the collector writes it, as the first entry of the document, so this is a transcript on its own as well.
    const odd = jsonl([
      user('show me the ledger', { ts: at('09:00:00'), session: 's2', extra: { toolUseResult: { format: 'claude-lifetime/claude-code-ledger' } } }),
      assistant({ ts: at('09:00:01'), session: 's2', id: 'msg_s2_0', req: 'req_s2_0', usage: tokens(100, 50) }),
    ]);
    expect(await outcome([fileOf('s2.jsonl', odd)])).toMatchObject({ parser: 'claude-code', recognisedAs: 'Claude Code session transcript' });
    expect(await outcome([fileOf('s1.jsonl', transcript('s1')), fileOf('s2.jsonl', odd)])).toMatchObject({ parser: 'claude-code', fileIndexes: [0, 1], ignoredFiles: 0 });
  });
});

describe('single files are recognised as before', () => {
  const page = reportPage(1, 3);
  const cases: Array<[string, ImportFile, Record<string, unknown>]> = [
    ['an empty file', fileOf('empty.json', ''), { error: 'unknown_format', message: '"empty.json" is empty.' }],
    ['white space only', fileOf('blank.jsonl', '  \n\n '), { error: 'unknown_format', message: '"blank.jsonl" contains only white space.' }],
    ['a transcript', fileOf('s1.jsonl', transcript('s1')), { parser: 'claude-code', recognisedAs: 'Claude Code session transcript' }],
    ['a .jsonl file with lines the app does not know', fileOf('finetune.jsonl', '{"messages":[]}\n{"messages":[]}\n'), { parser: 'claude-code', recognisedAs: 'Claude Code session transcript' }],
    ['a .ndjson file with lines the app does not know', fileOf('rows.ndjson', '{"a":1}\n{"a":2}\n'), { error: 'unknown_format', message: expect.stringMatching(/^"rows\.ndjson" is a JSON document, but not one of the formats this app reads\./) }],
    ['JSON Lines usage records', fileOf('usage.jsonl', usageLines('a')), { parser: 'generic-json', recognisedAs: 'JSON Lines file with usage records in the Claude Lifetime format' }],
    ['JSON Lines usage records under a .json name', fileOf('usage.json', usageLines('a')), { parser: 'generic-json', recognisedAs: 'JSON Lines file with usage records in the Claude Lifetime format' }],
    ['a usage document', fileOf('usage.json', JSON.stringify({ format: 'claude-lifetime/usage', version: 1, records: [] })), { parser: 'generic-json', recognisedAs: 'JSON file with usage records in the Claude Lifetime format' }],
    ['a report page, compact', fileOf('page.json', JSON.stringify(page)), { parser: 'api-usage', recognisedAs: 'JSON file with an Anthropic API usage report' }],
    ['a report page, compact with a line break at the end', fileOf('page.json', `${JSON.stringify(page)}\n`), { parser: 'api-usage', recognisedAs: 'JSON Lines file with an Anthropic API usage report' }],
    ['a report page, pretty-printed', fileOf('page.json', JSON.stringify(page, null, 2)), { parser: 'api-usage', recognisedAs: 'JSON file with an Anthropic API usage report' }],
    ['report pages, one per line', fileOf('pages.jsonl', jsonl([page, reportPage(2, 3)])), { parser: 'api-usage', recognisedAs: 'JSON Lines file with an Anthropic API usage report' }],
    [
      'an error response of the API',
      fileOf('usage.json', JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })),
      { error: 'unknown_format', message: expect.stringMatching(/is an error response from the Anthropic API, not a report: invalid x-api-key \(authentication_error\)/) },
    ],
    ['another JSON document', fileOf('notes.json', '{"hello":"world"}'), { error: 'unknown_format', message: expect.stringMatching(/^"notes\.json" is a JSON document, but not one of the formats this app reads\./) }],
    ['other JSON values, one per line', fileOf('notes.json', '{"hello":"world"}\n{"hello":"again"}\n'), { error: 'unknown_format', message: expect.stringMatching(/is a JSON document, but not one of the formats/) }],
    ['a JSON document that is cut off', fileOf('page.json', '{"data": [{"starting_at": "2026-01-01T00:00:00Z",'), { error: 'unknown_format', message: expect.stringMatching(/starts like a JSON document but cannot be parsed .*The file may be incomplete\.$/) }],
    [
      'conversations wrapped in an object',
      fileOf('export.json', `{"conversations": ${fixtureExport()}}`),
      { error: 'unknown_format', message: expect.stringMatching(/wraps its conversations in an object/) },
    ],
    ['a claude.ai export', fileOf('conversations.json', fixtureExport()), { parser: 'claude-export', recognisedAs: 'conversations.json from a claude.ai data export' }],
    ['a CSV file with usage columns', fileOf('usage.csv', 'timestamp,model,input_tokens,output_tokens\n2026-03-01,claude-sonnet-4-6,10,5\n'), { parser: 'generic-csv', recognisedAs: 'CSV file with recognisable usage columns' }],
  ];
  for (const [name, file, expected] of cases) {
    it(name, async () => {
      expect(await outcome([file])).toMatchObject(expected);
    });
  }
});

describe('more files than are looked at one by one', () => {
  it('refuses 201 report pages with advice for report pages, and accepts 200', async () => {
    const files = Array.from({ length: 201 }, (_, i) => fileOf(`usage-page-${i}.json`, JSON.stringify(reportPage(i + 1))));
    const result = await outcome(files);
    expect(result).toEqual({
      error: 'too_many_files',
      message:
        'This selection has 201 files. Each file is opened to see what it is, and that is done for at most 200 files per import. ' +
        'They look like pages of an Anthropic API usage report. Put the pages into one file (a JSON list of the pages, or one page per line) and import that file.',
    });
    expect(await outcome(files.slice(0, 200))).toMatchObject({ parser: 'api-usage', ignoredFiles: 0 });

    // What the message advises is something the importer accepts.
    const joined = fileOf('all-pages.json', JSON.stringify(files.map((_, i) => reportPage(i + 1))));
    expect(await outcome([joined])).toMatchObject({ parser: 'api-usage' });
    const { sink, out } = collectingSink();
    await apiUsageReportParser.parse([joined], sink, {});
    expect(out.usage).toHaveLength(201);
  });

  it('names the kind that was found for other files too, and never advises about transcripts unless transcripts were found', async () => {
    const result = await outcome(Array.from({ length: 201 }, (_, i) => fileOf(`usage-${i}.jsonl`, usageLines(`u${i}`))));
    expect(result).toMatchObject({ error: 'too_many_files' });
    const message = (result as { message: string }).message;
    expect(message).toMatch(/They look like usage files in the Claude Lifetime format\. Import them in groups of up to 200/);
    expect(message).not.toMatch(/Claude Code/);
  });
});

function fixtureExport(): string {
  return JSON.stringify([
    {
      uuid: '00000001-0000-4000-8000-000000000000',
      name: 'Planning a week in Lisbon',
      created_at: '2025-03-03T09:12:00.000000+00:00',
      updated_at: '2025-03-03T09:15:40.000000+00:00',
      account: { uuid: '00000000-aaaa-4bbb-8ccc-000000000001' },
      chat_messages: [{ uuid: '00000001-0000-4000-8000-000000000001', text: 'Six days in Lisbon?', sender: 'human', created_at: '2025-03-03T09:12:00.000000+00:00' }],
    },
  ]);
}

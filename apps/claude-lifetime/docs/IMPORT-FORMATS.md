# Import formats

Every import goes through the same steps: the app works out what the file is from its
contents, reads it in a background worker, shows a preview (records found, new versus
already stored, missing fields, notes), and stores nothing until you choose "Save to my
history". Importing the same file again adds nothing.

Every format below can also be chosen inside a ZIP archive. The app opens the archive in
the browser and reads the files in it as if they had been unpacked and chosen: `.jsonl`,
`.json`, `.csv` and `.tsv` files, in any folder of the archive, and ZIP archives inside it
up to two levels deep. It skips the same folders as for a dropped folder (`tool-results`,
`mcp-tasks`, `node_modules`, `.git`) and the `__MACOSX` copies macOS adds. Nothing is
unpacked to disk: a transcript is inflated while it is read. Archives with a password and
compression methods other than "stored" and "deflate" are refused with a message. A
claude.ai export stays as it is (see below); any other import is listed under the
archive's name, for example "claude-backup.zip (12 transcript files)".

## claude.ai data export

**Get it:** on claude.ai or in Claude Desktop open Settings, then Privacy, and choose
"Export data" (not available in the iOS and Android apps). A download link is emailed to
the account's address; it expires 24 hours after it is created and may work only once.
Members of Team and Enterprise organizations can export only if an owner allows it.

**Choose:** the ZIP exactly as downloaded, or the `conversations.json` inside it. All
known packagings are recognised: the classic ZIP, the `data-…-batch-0000.zip` form, and
the multi-part form where one part is named `conversations-000.zip`.

**Read from it:** per conversation the id, title and dates; per message the id, sender,
time, text, thinking, tool calls and results, and the extracted text of attachments. The
file is streamed, so an export of a gigabyte or more does not have to fit in memory.

**Not in it:** token counts, model names, the link between a chat and its project,
binary files. See [DATA-LIMITATIONS.md](DATA-LIMITATIONS.md).

**Stored:** conversations and message metadata (sizes, times, estimates). Message text
is measured and discarded.

## Claude Code transcripts

**Where they are:** `~/.claude/projects/<project>/<session>.jsonl`, plus
`<session>/subagents/…/agent-*.jsonl` for subagents. `CLAUDE_CONFIG_DIR` moves the
folder. On Windows it is `%USERPROFILE%\.claude`.

**Choose:** the `.claude` folder or its `projects` folder ("Choose the folder"), or drop
the folder on the import page. Individual `.jsonl` files work too, and so does a ZIP of
either folder ("Choose a ZIP"), made on another computer for example. File dialogs hide
dot-folders by default: press Cmd+Shift+. on macOS or Ctrl+H on Linux, or type the path.
Files read from a ZIP carry the archive's name in their path, so importing the same
archive again skips the transcripts in it that have not changed.

**Read from it:** for every model response the input, output, cache-read and cache-write
tokens (5-minute and 1-hour), the model, the service tier, whether inference was kept in
the US, web searches, the session and project, and how many prompts you typed. Each
response is counted once, identified by its message id, across all files: resumed, branched
and moved sessions and subagent files that repeat a response do not add to it. Behind a
gateway that issues its own message ids, the lines of a response are recognised by standing
together in the file. No prompt or reply text is stored.

**Stored:** one conversation per session and usage in 15-minute buckets per session and
model.

**Good to know**

- A response that Claude Code was still writing less than ten minutes ago, or that was
  interrupted then, is left out and picked up by the next import. A prompt whose answer is
  not there yet waits with it. Finished responses are counted at once, however recent.
- Claude Code deletes transcripts after `cleanupPeriodDays` (default 30). Set it to a
  large value such as 3650 in `~/.claude/settings.json` to keep them.
- In Chrome and Edge the folder can be remembered. "Read the folder again" then reads
  only files that changed, and files its usage under the same source as the first time.
- To keep several computers apart, give each a name in the field on the import page.
  The name is remembered on this device. It decides which source the usage is filed
  under, so keep it the same for the same computer.
- Deleting Claude Code usage switches automatic reading of the folder off, because it
  would add the deleted usage again on the next visit. Restoring a backup switches it off
  as well, so that the restored data stays as the backup has it. The folder stays
  remembered, the import page says why the switch is off, and it can be switched back on.

## Claude Code ledger (collector script)

The collector is a single file you can download from the import page
(`claude-lifetime-collect.mjs`). It needs Node.js 20 or newer and nothing else.

```bash
node claude-lifetime-collect.mjs
```

It reads the transcripts and writes or updates
`~/.claude-lifetime/claude-code-ledger.json`. The ledger holds one compact row per
response and per prompt: the same figures the app would read from the transcripts, plus
session titles, working directories and git branch names. It contains no message text.
It only ever grows, so usage stays on record after Claude Code cleans up the transcripts.
Import the ledger file like any other file; transcripts and ledger can be mixed freely,
since both identify a response by the same key.

Next to the ledger the collector keeps `claude-code-ledger.files.json`, a list of the
transcripts it has read (path, size, date). A later run reads only transcripts that are new
or have changed. The first run reads everything, which can take minutes for gigabytes of
transcripts; it saves about every half gigabyte, so a run that is stopped early (a hook's
time limit, for example) has still made progress and the next run continues from there.
Deleting the list is harmless: the next run reads everything again and adds nothing twice.

| Option | Meaning |
|---|---|
| `--dir <folder>` | Claude Code config folder to read (repeatable). Default: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. |
| `--ledger <file>` | Ledger to update. Default: `~/.claude-lifetime/claude-code-ledger.json`. |
| `--out <file>` | Also write a copy of the ledger there. |
| `--quiet` | Print nothing unless something goes wrong. |

A damaged ledger, or one written by a newer collector, is never overwritten.

The exit status is 0 when the ledger is up to date, 1 when nothing was found or on an
error, and 3 when the ledger was updated but a folder could not be opened or a transcript
could not be read (for example a project folder created by another user). The folders and
files are named, also with `--quiet`.

To run it automatically whenever a Claude Code session ends, add a hook to
`~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "node \"$HOME/claude-lifetime-collect.mjs\" --quiet", "timeout": 60 }
        ]
      }
    ]
  }
}
```

The `timeout` matters: without it Claude Code gives `SessionEnd` hooks 1.5 seconds.

## Anthropic API usage and cost reports

**Claude Console (any account with Console access):** on the Usage and Cost pages choose
export; the CSV files are recognised by their header row.

**Admin API (organizations only):** save the JSON responses of the usage report and cost
report endpoints. Both generations of the API are recognised (the usage and cost report
endpoints and the analytics endpoints). A report that spans several pages: select all
page files together (up to 200 files in one import), or keep the pages in one file, as a
JSON list of the pages or with one page per line. The Admin API needs an admin key and is
not available to individual accounts.

**Read from it:** per time bucket the uncached input, cache-read, cache-write (5-minute
and 1-hour) and output tokens, web searches, and the dimensions the report was grouped by
(model, service tier, context window, speed, inference geography). Cost reports give
billed amounts, which are stored as actual spend, to the hundred-millionth of a dollar.

**Good to know**

- A report restates its period: rows already stored for the same source and period are
  replaced where the new report states them differently or no longer lists them, not
  added to. Importing the same report twice changes nothing.
- Each file speaks for its own period. Files of January and of March that are imported
  together leave what is stored for February alone. A Console export speaks for the
  stretch from its first row to its last, and an export with hourly rows for the whole
  UTC days it touches.
- Pages of the older usage and cost report endpoints can be imported together or one
  at a time: each page is a complete statement of its days. If a page is missing, the
  import says from when, and the time of that page is left as it is.
- Pages of the analytics endpoints must be selected together. Their rows are ranked by
  size, not by date, so a page on its own is not a period; a selection that lacks the
  last page is refused.
- The same period under two groupings in one import (for example not broken down, and
  by model) is refused: added up, the usage would be counted twice. Import the more
  detailed files, or one file at a time.
- Reports that were filtered differently (one workspace, one API key) and grouped
  alike look the same row for row, so they replace each other, also when they are
  selected together. Request one report grouped by workspace or API key instead.
- A report must cover whole stored periods. An hourly report that starts or ends in the
  middle of a day that is already stored as one daily total is refused, with the day
  named: adding it would count that time twice. A report from the older endpoints that
  runs from midnight to midnight (UTC) always fits. The analytics endpoints leave out
  hours without usage, so their hourly report of a day can be refused although it
  covers the day; delete the earlier import of that day first.
- Rows that a later report replaced do not come back when that report is deleted.
  Import the earlier file again if you need them.
- Group the report by model. Rows of an ungrouped report have no model and cannot be
  priced.
- Ask for daily buckets or finer. A report row that adds up more than one day (an
  analytics report requested without time buckets) is exact as a total and reaches to
  its last day in every date the app shows, but the day-by-day views can only place it
  on the day it starts: the report does not say how the usage fell on the days.
- Usage in the `priority`, `flex` or long-context tiers of models with no published price
  for that tier is counted but left unpriced.
- Whether a file is a usage or a cost report is read from its figures, wherever in the
  file the first one stands. A cost report that begins before the first spend, with a
  page of empty days, is a cost report all the same, and an empty page that is selected
  with other pages goes with them. A report without a single figure is reported as
  empty.
- A saved error response (for example an authentication error) is recognised and
  explained instead of being rejected as an unknown file.

## CSV table

One row per request or per period. Comma, semicolon or tab separated; UTF-8, or UTF-16
with a byte order mark; column names in the first row. Only `timestamp` and one token
column are required. "Download CSV template" on the import page gives a header row with
every column.

```
timestamp,model,input_tokens,output_tokens,cache_read_tokens,cache_write_5m_tokens,cache_write_1h_tokens,requests,conversation_id,conversation_title,id,price_tier,bucket_seconds
2026-03-01T09:15:00Z,claude-sonnet-4-6,1200,350,8000,0,0,1,conv-1,Refactoring notes,req-0001,standard,
2026-03-02,claude-opus-4-6,50000,12000,0,0,0,40,,,day-2026-03-02,batch,
```

| Column | Meaning |
|---|---|
| `timestamp` | ISO 8601 date-time (UTC unless it has an offset), a date `YYYY-MM-DD` (the whole UTC day), or Unix seconds or milliseconds. Required. |
| `model` | API model id, for example `claude-sonnet-4-5-20250929`. Unknown ids are kept as they are. Without a model the tokens are counted but not priced. |
| `input_tokens`, `output_tokens` | Uncached input and output tokens. |
| `cache_read_tokens` | Input tokens read from the prompt cache. |
| `cache_write_5m_tokens`, `cache_write_1h_tokens`, `cache_write_tokens` | Cache writes by lifetime; the last one when the lifetime is unknown (stored as 5-minute writes). |
| `total_tokens` | Used only for rows without an input/output split. Such rows are counted but never priced. |
| `requests` | Number of API requests in the row. |
| `conversation_id`, `conversation_title` | Group rows into a conversation. |
| `id` | Identifies the row. The same id is never imported twice into the same source. Without it, rows identical in every field count once. |
| `price_tier` | `standard` (default), `batch`, `fast`, `long_context`, `priority`, `flex`. |
| `bucket_seconds` | Width of the period a row adds up, in seconds. Default: 86400 for a date, otherwise 0. A row that adds up more than one day (2592000 for a 30-day total) is stored as one row for each day, with its counts divided evenly, because the file does not say how the usage was distributed; a period that is still running is divided over its days up to today. Totals are unchanged, the preview says how many rows this applies to, and a figure for a single day or week inside such a period is an even share, not a measurement. Ten years at most. |

Columns can have other names: the import shows a mapping step where you match your
columns to these fields. You also say whether the counts are exact (metered by the API
or a tool that reads them from it) or estimates, and can name the source. The name can
be in any script. Tables with different names are different sources; upper and lower
case, spacing and punctuation make no difference. A table without a name goes to the
source "Custom usage data".

A row with more values than the header has columns is skipped and reported in the
preview. One of its values probably contains the delimiter, for example a number
written as 1,200,000, and the values after it can no longer be matched to their
columns. Enclose such values in quotation marks. A delimiter at the end of a row counts
as one more value. A row with fewer values is read; the values missing at its end count
as empty.

Rows are recognised as already stored within one source, and only when the same columns
are read as the same fields. The choices you make for a table (source name, column
meanings, exact or estimated) are therefore remembered on this device by the names of
its columns and filled in the next time: importing a newer version of the same table
adds only its new rows. If you import the very same file under a different source name,
the preview warns that saving would count it twice.

## JSON usage file

The same records as the CSV, for exports from other systems.

```json
{
  "format": "claude-lifetime/usage",
  "version": 1,
  "source": { "label": "My proxy logs", "ref": "proxy-eu-1" },
  "records": [
    { "timestamp": "2026-03-01T09:15:00Z", "model": "claude-sonnet-4-6", "input_tokens": 1200, "output_tokens": 350, "id": "req-0001" },
    { "timestamp": "2026-03-02", "model": "claude-opus-4-6", "total_tokens": 62000 }
  ]
}
```

`source` is optional; `ref` keeps files of different origins apart. A bare array of
records and JSON Lines (one record per line) are accepted as well and are read record by
record, which suits very large files. `version` is 1, and `records` is a list.

**Good to know**

- The format has no field that says whether the counts were metered. Before the file
  is read, the import asks whether they are exact (metered by the API or a tool that
  reads them from it) or estimates. The answer applies to every record of the import;
  "Estimated" is the default.
- One import is filed under one source. Files that name different sources (another
  `ref` or another `label`) are refused when they are selected together: import them
  one at a time, so that each is filed under its own source. Files that name the same
  source, or none, can be selected together.
- Write `id` and `conversation_id` as text. A number works as long as JSON holds it
  exactly, which is up to 9007199254740991. A larger number, or one with a fraction, is
  not used as an id: the record is still imported and is identified by its content,
  and it joins no conversation if it was a conversation id. The preview says how many
  records this concerns.

## Manual entry

"Add usage by hand" on the import page stores one day of usage as its own import: date,
optional model, token counts by category, whether the figure is exact or your own
estimate, and a note. The day can be any day from 2021 up to today in the timezone set
in Settings, and each count at most 1,000,000,000,000 tokens.

## When a file is not accepted

The message names the file and says what was found. The most common cases:

| Message | What to do |
|---|---|
| The archive does not contain a conversations.json file | Choose the ZIP from the export email, or the part named "conversations" if it came in several parts. |
| The ZIP archive is incomplete | The download was cut short. Download the file again; for a claude.ai export, request a new one, as the link works for a limited time. |
| … is a ZIP archive, but none of the files in it is one this app can read | The message lists what the archive holds. Choose the file you meant, or an archive that contains it. |
| … in the ZIP archive is damaged and could not be unpacked | Download or make the archive again. |
| … is password-protected | Make the archive again without a password, or unpack it and choose the files. |
| No Claude Code transcripts were found | Choose the `.claude` folder or its `projects` folder. |
| These files contain no token usage | Transcripts older than the retention period were already deleted. |
| … is an error response from the Anthropic API | The request failed when the file was saved. Run it again with a valid admin key. |
| Another import is being prepared in a different tab | Finish or cancel it there; all tabs share one database. |
| This selection has … files | Files that are not found by their name are opened one by one, at most 200 per import. The message says what they look like and how to import them: a folder for Claude Code transcripts, one file with all pages for a report, groups of 200 for the rest. |

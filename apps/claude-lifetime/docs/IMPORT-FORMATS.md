# Import formats

Every import goes through the same steps: the app works out what the file is from its
contents, reads it in a background worker, shows a preview (records found, new versus
already stored, missing fields, notes), and stores nothing until you choose "Save to my
history". Importing the same file again adds nothing.

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
the folder on the import page. Individual `.jsonl` files work too. File dialogs hide
dot-folders by default: press Cmd+Shift+. on macOS or Ctrl+H on Linux, or type the path.

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
  would add the deleted usage again on the next visit. It can be switched back on.

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
page files together. The Admin API needs an admin key and is not available to individual
accounts.

**Read from it:** per time bucket the uncached input, cache-read, cache-write (5-minute
and 1-hour) and output tokens, web searches, and the dimensions the report was grouped by
(model, service tier, context window, speed). Cost reports give billed amounts, which are
stored as actual spend.

**Good to know**

- A report restates its period: rows already stored for the same source and period are
  replaced where the new report states them differently or no longer lists them, not
  added to. Importing the same report twice changes nothing.
- A report must cover whole stored periods. An hourly report that starts or ends in the
  middle of a day that is already stored as one daily total is refused, with the day
  named: adding it would count that time twice. Export it from midnight to midnight
  (UTC), or delete the earlier import first.
- Rows that a later report replaced do not come back when that report is deleted.
  Import the earlier file again if you need them.
- Group the report by model. Rows of an ungrouped report have no model and cannot be
  priced.
- Usage in the `priority`, `flex` or long-context tiers of models with no published price
  for that tier is counted but left unpriced.
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
| `bucket_seconds` | Width of the period a row adds up. Default: 86400 for a date, otherwise 0. |

Columns can have other names: the import shows a mapping step where you match your
columns to these fields. You also say whether the counts are exact (metered by the API
or a tool that reads them from it) or estimates, and can name the source.

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
record, which suits very large files.

## Manual entry

"Add usage by hand" on the import page stores one day of usage as its own import: date,
optional model, token counts by category, whether the figure is exact or your own
estimate, and a note.

## When a file is not accepted

The message names the file and says what was found. The most common cases:

| Message | What to do |
|---|---|
| The archive does not contain a conversations.json file | Choose the ZIP from the export email, or the part named "conversations" if it came in several parts. |
| The ZIP archive is incomplete | The download was cut short. Request a new export; the link works for a limited time. |
| No Claude Code transcripts were found | Choose the `.claude` folder or its `projects` folder. |
| These files contain no token usage | Transcripts older than the retention period were already deleted. |
| … is an error response from the Anthropic API | The request failed when the file was saved. Run it again with a valid admin key. |
| Another import is being prepared in a different tab | Finish or cancel it there; all tabs share one database. |

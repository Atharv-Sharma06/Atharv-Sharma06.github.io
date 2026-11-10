# What your data can and cannot tell

Claude Lifetime only shows what the files you import support. This page lists, source by
source, what is known exactly, what is estimated, and what cannot be recovered at all.
The app shows the same information for your own data in the panel "What We Know About
Your Claude History" on the overview.

## The three labels

| Label | Meaning | Examples |
|---|---|---|
| **Exact** | A source metered the tokens itself; the app only adds them up. | Claude Code transcripts, Anthropic usage reports, manual entries you marked as copied from a report |
| **Estimated** | Reconstructed from text because the source has no token counts. A total that includes an estimated part is labelled estimated. | claude.ai conversations, CSV rows you did not declare exact |
| **Unavailable** | No imported source has the information. The app shows a dash and the reason, never a zero or a guess. | The model behind a chat message, the split before/after a subscription when no dates were entered |

No figure in this app is an official Anthropic accounting of your account. Anthropic does
not publish a lifetime token total for consumer accounts, and there is no supported API
that returns your claude.ai conversations or their token usage. The app therefore never
asks for your password and never calls claude.ai on your behalf.

## claude.ai data export

Requested under Settings, Privacy, "Export data" on claude.ai or in Claude Desktop. It
covers chats from the web, desktop and mobile apps of one account.

| Question | Answer |
|---|---|
| Conversations, messages, dates | In the export. Counts are exact counts of what the export contains. |
| Token counts | **Not in the export.** Estimated from the text (see [TOKEN-ESTIMATION.md](TOKEN-ESTIMATION.md)). |
| Model that answered | **Not in the export.** Shown as "Unknown model". No model is guessed, and this usage is not priced unless you choose an assumed model yourself. |
| Deleted conversations | Not included in exports made after the deletion. |
| System prompt, tool definitions, project knowledge, memory, styles | Sent to the model, not in the export, not counted. Real usage is higher. |
| Images, PDFs and other binary files | The export lists file names only. Their tokens are not counted. |
| Extended thinking | Visible thinking text is counted. It can be a summary, so billed thinking may be higher. |
| Edits and regenerated replies | Recent exports record which message each reply answered, and the app follows each branch. Older exports do not; the app then treats the messages as one thread in the order of their timestamps, and flags every conversation with more than one prompt, because an edited prompt cannot be told apart from a next turn. |
| Which project a chat belonged to | Not linked in the export. |

Each estimated message stores which of these limitations apply to it. The conversation
page lists them, and the overview totals them.

## Claude Code

Claude Code writes session transcripts to `~/.claude/projects/` (or the folder named by
`CLAUDE_CONFIG_DIR`). Each model response is logged with the usage the API reported.

| Question | Answer |
|---|---|
| Input, output, cache read and cache write tokens | Exact, per response. |
| Model, time, project, session | Recorded. |
| Subagent usage | Recorded in separate files, which are read as well. |
| History older than the retention period | **Gone.** Claude Code deletes transcripts after `cleanupPeriodDays`, 30 days by default. Raise the setting and run the collector to keep a permanent ledger. |
| Requests that Claude Code makes on the side (titles, summaries) | May not be in the transcripts. Totals can be slightly below what was billed. |
| Responses interrupted before their final line was written | Their output tokens cannot be recovered; they are counted with what is there and flagged. |
| Responses still being written when you import | Left out and picked up by the next import. |
| `stats-cache.json` | Not used. Its totals change definition between Claude Code versions and include repeated counts, so they cannot be reconciled with the per-response records. |

Usage on a Pro or Max subscription and usage billed through an API key look the same in
the transcripts. If you also import API usage reports for the same key, the same tokens
would be counted twice; leave one of the two sources out of the totals in Settings.

## Anthropic API reports

| Question | Answer |
|---|---|
| Token counts per time bucket | Exact. |
| Model, service tier, context window | Present when the report was grouped by them. Ungrouped rows are "Unknown model". |
| Billed cost | Cost reports are stored as actual spend and never mixed into token totals or the equivalent API value. |
| Individual requests and conversations | Not in a report. Reports are aggregates. |
| Who can get them | The Admin API needs an organization admin key and is **not available to individual accounts**. The Claude Console's Usage and Cost pages can be exported as CSV. |

A later report for the same period replaces the earlier rows where it states them
differently or no longer lists them; it is not added. Reports filtered differently (one
workspace, one API key) for the same period therefore replace each other. Import
unfiltered reports, or select the files together in one import. A report cannot replace
part of a stored total: an hourly report that begins in the middle of a day stored as
one daily row is refused rather than counted on top of it. Rows that were replaced do
not return when the replacing import is deleted; the import history notes this on both
imports.

## CSV, JSON and manual entries

These are your own figures. They are stored as estimates unless you declare them exact,
and rows without a model are counted but not priced.

## Equivalent API value

A hypothetical figure: what the recorded usage would cost at Anthropic's published API
prices. It is not money you paid.

- Usage with no recorded model is left unpriced, and the unpriced amount is shown.
- Some combinations have no published price on file (for example a price tier on a model
  that does not offer it); they are listed as unpriced with the reason.
- Requests that asked for US-only inference are valued at 1.1 times the price of their
  tier, the multiplier Anthropic publishes for Claude 4.6 and later models. Claude Code
  transcripts state this per response.
- For estimated chat usage the result depends on whether prompt caching is assumed, so
  both scenarios are computed.
- Prices change. Each price carries its source link and the date it was read, and you
  can add or correct prices in Settings.

## Subscription periods

No file contains your plan history. You enter it. Time not covered by a period is shown
as "No subscription recorded", not as Free. A period is the calendar days you entered:
usage belongs to the plan that was active on the day it is charted on, and the dates do
not change when you change the timezone setting.

The before/after comparison splits at your first paid period. The two sides usually
differ in length and in how they were measured (estimated chat text before, metered
Claude Code after), so the app compares rates and does not print growth percentages for
totals.

Per-day averages, for each plan and for either side of the comparison, count only the
days between your first and your last imported record. If you subscribed two years ago
but your Claude Code logs go back thirty days, the plan is averaged over those thirty
days: nothing is known about the others, which is not the same as no usage.

The amount shown as paid is worked out from the monthly prices and dates you entered,
one payment for every monthly cycle that has started. It is not read from invoices, so
taxes, discounts and yearly billing are not reflected.

## What can never be shown

- A percentage of your all-time usage that the imported files cover. No source knows the
  true total, so there is nothing honest to divide by. The app shows the imported
  sources, their date ranges and the gaps between them.
- Whether a gap means you did not use Claude or that the usage is in a file you have not
  imported.

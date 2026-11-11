# Claude Lifetime

Your entire history with Claude, quantified.

Claude Lifetime is a personal analytics dashboard for your own Claude usage: lifetime
tokens, conversations, models, subscription periods and what the same usage would have
cost through the API. You import files you already have or can request (your claude.ai
data export, Claude Code session logs, Anthropic API reports), and the app reconstructs
the picture from them.

It is published as part of the portfolio at
**https://atharv-sharma06.github.io/claude-lifetime/** and runs entirely in the browser.
There is no server and no account: everything you import is stored in a database inside
your browser, on your device.

## What it does

- Reads the **claude.ai data export**, **Claude Code transcripts**, **Anthropic API usage
  and cost reports** (Admin API JSON and Claude Console CSV), and **CSV or JSON tables**
  of your own. Single days can also be typed in by hand.
- Labels every figure **Exact** (metered by the source), **Estimated** (reconstructed
  from text, or stated by a file or an entry that does not mark it as exact) or
  **Unavailable** (no source has it). Exact and estimated tokens are kept apart in the
  database and in every chart.
- Shows lifetime totals, usage over time (daily to yearly, cumulative, by token category,
  by model, by plan), an activity heatmap, a model breakdown, a searchable conversation
  explorer, and a subscription timeline with a before/after comparison.
- Prices usage at Anthropic's published API rates as an **equivalent API value**, kept
  visibly apart from money actually paid.
- Previews every import before saving it, never counts the same record twice, and lets you
  delete any import, any source, or everything.

## What it cannot do

Anthropic does not publish a lifetime token count for consumer accounts, and this app
does not pretend otherwise. It never asks for your password, never calls private
claude.ai endpoints and never fetches anything from your account. In particular:

- A claude.ai export has **no token counts and no model names**. Tokens for chats are
  estimates, and chat usage cannot be priced per model.
- Conversations deleted before an export, and Claude Code transcripts that were already
  cleaned up (after 30 days by default), are gone.
- System prompts, tool definitions, images and files cost tokens but are not in an export.
- The app cannot tell what share of your all-time usage your files cover, so it shows
  what was imported (sources, dates, gaps) and no percentage.

Details: [docs/DATA-LIMITATIONS.md](docs/DATA-LIMITATIONS.md) and
[docs/TOKEN-ESTIMATION.md](docs/TOKEN-ESTIMATION.md). The same explanations are in the app
under "How it is counted".

## Run it locally

Requirements: Node.js 22.12 or newer and npm. No database server and no environment file
are needed.

```bash
cd apps/claude-lifetime
```

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:3000/claude-lifetime/. The first start downloads nothing from the
internet; `npm run dev` prepares the PostgreSQL WebAssembly files from `node_modules`.

To look around before importing anything, choose **Explore with demo data** on the first
screen. The demo dataset is synthetic, is labelled as such on every page, cannot be
loaded next to real data, and is removed automatically when you import a real file.

## Import your history

Open **Import Data** ("Recover Your Claude History"). Drop a file or folder, or use one of
the options. The app detects the format from the contents, shows what would be added,
what is duplicated and what the file cannot tell, and saves only when you confirm.

| Source | How to get it | Figures |
|---|---|---|
| claude.ai data export | On claude.ai or in Claude Desktop: Settings, Privacy, "Export data". A download link arrives by email and expires after 24 hours. Choose the ZIP as downloaded. | Estimated |
| Claude Code sessions | Choose your Claude Code folder (`~/.claude`, or the `projects` folder inside it), or a ZIP of it. | Exact |
| Claude Code ledger | Run the collector script (see below) and import the file it writes. | Exact |
| API usage and cost | Claude Console: export the Usage and Cost pages as CSV. With an organization admin key: save the JSON of the Admin API usage and cost report endpoints. | Exact |
| CSV or JSON table | Any table with a date and token counts; you map the columns. | As you declare |
| Manual entry | "Add usage by hand" on the import page. | As you declare |

Any of these files can also be chosen inside a ZIP archive: the app opens it in the
browser and reads the files in it, without unpacking anything to disk.

File formats, the CSV/JSON schema and every error message are described in
[docs/IMPORT-FORMATS.md](docs/IMPORT-FORMATS.md).

## Enter your subscription timeline

No export says when you were on Free, Pro or Max. Open **Subscription History**, choose
**Add period** and enter each plan with its start date and, if it ended, its end date.
Any number of changes is fine (Free, Pro, Max, back to Free, Pro again). Usage is
assigned to a plan by date when it is displayed, so editing a period re-classifies your
whole history immediately. The first paid period is where the "before" and "after
subscription" figures split.

## Keep tracking new usage

Claude Code deletes its transcripts after `cleanupPeriodDays` (30 by default). Three
supported ways to keep your record complete, all on your own machine:

1. **Remember the folder.** In Chrome or Edge, choose the Claude Code folder once on the
   import page. "Read the folder again" then adds only new sessions, and an optional
   switch lets the app do that by itself whenever you open it, as long as the browser
   still allows reading the folder.
2. **Run the collector.** Download `claude-lifetime-collect.mjs` from the import page and
   run it with Node. It copies the usage figures (never conversation text) from the
   transcripts into a ledger file, `~/.claude-lifetime/claude-code-ledger.json`, which you
   import like any other file. The ledger only grows, so nothing is lost when
   transcripts are cleaned up.

   ```bash
   node claude-lifetime-collect.mjs
   ```

3. **Run the collector automatically.** Add a `SessionEnd` hook to
   `~/.claude/settings.json` so the ledger is updated every time a Claude Code session
   ends, and raise the retention while you are there:

   ```json
   {
     "cleanupPeriodDays": 3650,
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

For chats, request a new export from claude.ai from time to time and import it. Only
conversations and messages that are new since the last import are added.

## Commands

Run these in `apps/claude-lifetime`.

| Command | What it does |
|---|---|
| `npm run dev` | Development server at http://localhost:3000/claude-lifetime/ |
| `npm test` | Unit and integration tests (Vitest). The integration tests run against a real PostgreSQL (PGlite) in memory. |
| `npm run typecheck` | TypeScript in strict mode |
| `npm run lint` | ESLint |
| `npm run build` | Static production build into `out/` |
| `npm run publish:site` | Build, then copy the result to `/claude-lifetime/` at the repository root, where GitHub Pages serves it |
| `npm run preview` | Serve the repository root at http://localhost:4173/ the way GitHub Pages does |
| `npm run test:e2e` | End-to-end tests (Playwright) against the published files. Run `npm run publish:site` first. |
| `npm run db:migration` | Print the SQL that would bring the migrations in line with `prisma/schema.prisma`. Needs a running PostgreSQL server and `SHADOW_DATABASE_URL` (see below) |
| `node scripts/calibrate-tokens.mjs` | Re-measure the token estimator against Anthropic's published tokenizer |

## How it is built

- **Next.js (App Router), React, TypeScript, Tailwind CSS**, Radix UI primitives, Lucide
  icons, Recharts, Motion. Exported as static files (`output: 'export'`).
- **PostgreSQL in the browser.** The database is PGlite (PostgreSQL compiled to
  WebAssembly) running in a Web Worker and persisted in IndexedDB. The schema is defined
  with **Prisma** (`prisma/schema.prisma`), Prisma generates the SQL migrations, and the
  app applies them itself on start. Every analytics figure is computed in SQL.
- **Importers run in a Web Worker** and stream large files with bounded memory. Parsed
  records go to staging tables first; the preview is computed from them, and saving
  merges them into the real tables in one transaction.
- **Several tabs share the one database.** The worker of one tab holds it and the others
  reach it through that worker. Closing or reloading a tab does not disturb the others:
  what a closed tab left unfinished is rolled back, and when the tab that held the
  database goes away another one takes over. An import that was being saved at that
  moment is not stored in part; the app says so, and it can be imported again.

The reasons for these choices, the data model and how to move the same schema to a server
are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Configuration

Nothing needs to be configured to run, test or build the app. [`.env.example`](.env.example)
lists the optional variables; copy it to `.env.local` to set them. One is the path the
app is served under. The other two are read only by the Prisma CLI, through
`prisma.config.ts`:

- `SHADOW_DATABASE_URL` is required by `npm run db:migration`. To compare the migrations
  with the schema, Prisma replays them in this database, so it needs a PostgreSQL server
  you can reach, and it erases whatever the database holds. Without the variable the
  command stops with "You must set `datasource.shadowDatabaseUrl`"; with a server that is
  not running it stops with error P1001.
- `DATABASE_URL` is the database `npx prisma migrate deploy` applies the migrations to,
  if you move the schema to a server-side PostgreSQL.

## Publishing to the portfolio

The portfolio is served by GitHub Pages directly from this repository, so the built app
is committed.

```bash
npm run publish:site
```

This builds the app and copies it to `claude-lifetime/` at the repository root (served at
`/claude-lifetime/`). The `.nojekyll` file at the root keeps GitHub Pages from dropping
the `_next/` folder. Commit the changes in `claude-lifetime/` together with the source.

## Privacy

- All processing happens on your device. The app makes no network request with your
  data and contains no analytics. The end-to-end tests fail if any page contacts another
  origin.
- The app stores metadata: titles, dates, sizes and token figures. For each Claude Code
  session it also stores the path of the project folder it ran in, its git branch, the
  version of Claude Code and whether it used subagents. These are part of every backup.
  It does **not** store the text of your messages; an export is read once to measure it.
- Backups ("Download backup" in Settings) can be protected with a passphrase. A backup
  is made from a fresh copy of the rows that are stored at that moment, so it holds
  nothing of what you deleted before. The database's own files are never handed out:
  like any database, they can keep remnants of deleted rows for a while.
- You can delete a single import, a whole source, all imported data, or the entire local
  database from the import page and Settings. What you delete leaves every figure and
  every later backup at once. "Erase the local database" in Settings also removes the
  database files from this device's storage, remnants included.

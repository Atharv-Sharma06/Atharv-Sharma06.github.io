# How tokens are counted and estimated

This page defines every token figure in Claude Lifetime. The app shows a shorter version
under "How it is counted".

## Two totals: new and processed

| Basis | Includes | Answers |
|---|---|---|
| **New tokens** | input + output + cache writes | How much content went to the model or came from it, each piece counted once |
| **Processed tokens** | new tokens + cache reads + re-read context | Everything the model read and wrote. This is what the API meters. |

A conversation is sent to the model again in full on every turn. In a long conversation
the processed total is therefore many times the new total. Both are honest; the Processed
and New switch chooses which one the charts show. It is in the top bar, or in the menu on
a screen narrower than 768 pixels, and under Token basis in Settings.

Token categories, as stored:

| Category | Exact sources (Claude Code, API reports) | Estimated sources (chat exports) |
|---|---|---|
| Input | uncached input tokens | your text, attachment text, tool results |
| Output | output tokens | reply text, visible thinking, tool calls |
| Cache writes | 5-minute and 1-hour cache creation tokens | none |
| Cache reads | cache read tokens | none |
| Re-read context | none | earlier conversation sent again with each request (modelled) |

Cache reads exist only in exact sources and re-read context only in estimated ones, so no
token is in two categories. "Exact" and "estimated" partition either total.

## Exact sources

Nothing is computed. Claude Code's per-response usage and the buckets of an API report
are stored as reported and added up in SQL.

## Estimating a chat export

A claude.ai export contains text, not token counts. Three steps turn text into tokens.

### 1. Counting text

`src/core/tokens/estimate.ts` estimates how many tokens a text is for the tokenizer
Anthropic published for Claude 2 (`@anthropic-ai/tokenizer`). One token of that tokenizer
is the app's **base unit**. The estimator reproduces how that tokenizer cuts text into
pieces (letter runs, digit runs, punctuation runs, whitespace) and prices each piece with
tables fitted against the real tokenizer. It runs in one pass, without shipping the
tokenizer's vocabulary, at 50 to 120 million characters per second, which is what makes
importing a gigabyte-sized export in the browser practical.

Measured against the real tokenizer (`node scripts/calibrate-tokens.mjs --all`;
error = estimate / actual - 1):

| Data set | Samples | Actual tokens | Error |
|---|---|---|---|
| Held-out documents (code, Markdown, JSON, logs, localisation files) | 1,035 | 1,637,709 | +0.56% |
| Hand-written fixtures in `tests/fixtures/tokens` | 42 | 46,009 | -0.13% |
| The half of each fixture not used for fitting | 41 | 17,506 | +0.02% |
| Universal Declaration of Human Rights, 28 languages, never used for fitting | 29 | 221,726 | +0.18% |

Per kind of content, on the fixtures:

| Content | Error | Characters per token (real tokenizer) |
|---|---|---|
| English prose | +1.2% | 4.5 |
| Chat-style English | +0.1% | 3.7 |
| Markdown | +0.4% | 3.6 |
| Source code (9 languages) | +1.7% | 3.3 |
| JSON | -0.2% | 2.9 |
| CSV and tables | -1.4% | 2.1 |
| Logs and stack traces | +1.9% | 2.6 |
| URLs, paths, hex, base64 | -1.7% | 2.1 |
| Numbers | -2.2% | 3.3 |
| Emoji-heavy text | -0.8% | 2.0 |
| Spanish, French, German, Portuguese | within ±0.6% | 3.1 to 3.4 |
| Italian | -3.0% | 2.9 |
| Russian, Ukrainian | -1.8%, -3.0% | 1.9, 1.6 |
| Greek, Arabic, Hebrew, Hindi, Bengali, Thai | within ±0.4% | 0.6 to 1.1 |
| Chinese, Japanese | -2.3%, -0.8% | 1.0 |
| Korean | **-7.8%** | 0.9 |

Of 2,891 samples with at least 2,000 characters, 99.6% are within ±12% and 92.6% within
±6%.

Known weak spots: everyday Korean prose (-6% to -12%), Chinese legal prose (-10%),
Russian technical text (+6%), languages the model was not fitted on (Dutch and Indonesian
about -14%, Urdu -8%), Vietnamese in decomposed Unicode form (+27%), and single documents
of unusual material such as long base64 blobs or hex test vectors (up to ±28%). Short
texts are noisier than long ones. Errors of individual messages largely cancel in totals.

### 2. Tokenizer generations

Claude models do not share a tokenizer, and Anthropic has not published the newer ones.
The base count is scaled by a factor per generation. The anchors are statements Anthropic
publishes:

- Before Claude Opus 4.7, "a token represents approximately 3.5 English characters".
- Opus 4.7 and later produce "approximately 30 percent more tokens for the same text".

The published tokenizer measures typical English at 3.9 to 4.7 characters per token,
which puts the Claude 3 to 4.6 generation at about 1.25 tokens per base unit.

| Generation | Tokens per base unit | Margin shown |
|---|---|---|
| Claude 2 and earlier | 1 | -8% to +8% |
| Claude 3 up to Opus 4.6, Sonnet 4.6, Haiku 4.5 | 1.25 | -12% to +12% |
| Opus 4.7 and later, Sonnet 5+, Haiku 5.5, Fable, Mythos | 1.625 | -32% to +16% |
| Model not recorded, message dated 16 Apr 2026 or later | 1.4375 | -23% to +31% |

An export does not say which model answered. The generation is therefore taken from the
date of the message alone, because only the generations that existed on that day are
possible: before 4 Mar 2024 the first, before 16 Apr 2026 the first two (the app uses the
second, which was the current one), and from then on the midpoint of the two current
generations with a margin that covers both.

Estimates are stored in base units together with the method that applies
(`token_estimates.method_id`), and the factor is applied when figures are read. A better
factor can therefore be adopted later without importing anything again.

The margin shown next to an estimated total is this generation uncertainty. It does not
cover content that is missing from the export (next section), which can only make the
real figure higher.

### 3. Reconstructing requests

An export lists messages. Usage is caused by requests. The app rebuilds the requests:

- Every reply needed at least one request whose input was the whole conversation so far.
- Every tool result that goes back to the model starts another request, which reads
  everything again. Tool calls that are answered together share one such request, and
  a call that never got a result (a reply that was stopped) adds none.
- A prompt counts as new input for the first request that actually carries it. If its
  reply never came, or came back empty, the prompt is still new input for the next
  reply on that thread; it is not counted a second time as re-read context.
- **Input** is new content: your text, attachment text, tool results.
  **Output** is what the model wrote: reply text, visible thinking, tool calls.
  **Re-read context** is everything that had already been sent and was sent again.
- Thinking is carried within a turn but not into later turns, as on the API.
- Re-read context is capped at a 200,000-token window, because a real request cannot
  exceed it. Capped messages are flagged.
- Exports that carry parent pointers are followed branch by branch, so an abandoned edit
  is not counted as context of the branch that replaced it. Exports without pointers are
  treated as one thread in the order of the message timestamps. Every such conversation
  with more than one prompt is flagged, because an edited prompt cannot be told apart
  from an ordinary next turn there.

For the cost scenario "with prompt caching" the model also tracks which part of the
re-read context a 5-minute prompt cache could have served: context that was sent less
than five minutes earlier and was not changed by dropped thinking. The five minutes run
from one request to the next, each timed by the moment the model began to answer
(recent exports time every block; older ones leave the time the prompt was sent). How
long a reply took to write therefore does not decide whether it could use the cache.

### What an estimate leaves out

Recorded per message as limitation flags, shown on the conversation page:

| Limitation | Effect |
|---|---|
| Model not recorded | Generation assumed from the date; no model-specific price |
| Hidden context excluded | System prompt, tool definitions, project knowledge, memory and styles are not counted |
| Images and files excluded | Binary uploads cost tokens but only their names are exported |
| Thinking may be summarised | Billed thinking can exceed the visible text |
| Tool overhead excluded | Tool definitions and server-side tool processing are not visible |
| Timestamp inferred | A missing or invalid time was replaced by a neighbouring one |
| Context capped | Re-read context was limited to the context window |
| Edits treated as one thread | No branch information in the export: the conversation has several prompts and is read as one thread in time order, which can include an exchange that was abandoned |
| Attachment text missing | An attachment had no extracted text |

## Equivalent API value

For each record: tokens per category × the price of its model and price tier that was in
effect on its day, in USD per million tokens, computed with exact decimal arithmetic in
SQL.

- **Exact usage**: input, output, cache reads, 5-minute and 1-hour cache writes each at
  their own price.
- **Estimated usage, without caching**: (input + re-read context) × input price + output
  × output price.
- **Estimated usage, with a 5-minute prompt cache**: the cacheable part of the re-read
  context at the cache-read price, everything else that was sent at the 5-minute
  cache-write price, output at the output price.
- **Web search**: per search.
- Records without a model, or with a model and tier that has no price on file, are
  **unpriced** and reported as such. If you choose an assumed model in Settings, usage
  without a model is priced as that model and labelled as an assumption.

Built-in prices were read from Anthropic's pricing page on 10 Nov 2026; prices of retired
models come from their launch announcements. Every price row stores its source link and
retrieval date. Prices you enter take precedence over built-in ones.

## Re-running the calibration

```bash
node scripts/calibrate-tokens.mjs
```

prints the per-class report for the fixtures. `--all` adds the corpora found on the
machine, `--fit` refits the tables, and `--fit --write` writes them into
`src/core/tokens/estimate.ts`. `tests/core/estimate-tokens.test.ts` asserts the accuracy
bounds, so a change that makes the estimator worse fails the test suite.

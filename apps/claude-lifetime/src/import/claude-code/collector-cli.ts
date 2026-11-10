import { runCli } from './collector';

/**
 * Entry point of the collector CLI. scripts/build-collector.mjs bundles this file
 * (with collector.ts, ledger.ts and extract.ts) into the single-file tool at
 * public/tools/claude-lifetime-collect.mjs. All logic lives in collector.ts so that
 * it can be tested in-process; this file only connects it to the terminal.
 */
const showProgress = process.stderr.isTTY === true;

runCli(process.argv.slice(2), {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
  // \r returns to the start of the line and ESC[K clears it, so the line updates in place.
  progress: showProgress ? (text) => void process.stderr.write(`\r\u001b[K${text}`) : undefined,
}).then(
  (status) => {
    process.exitCode = status;
  },
  (err: unknown) => {
    process.stderr.write(`Unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  },
);

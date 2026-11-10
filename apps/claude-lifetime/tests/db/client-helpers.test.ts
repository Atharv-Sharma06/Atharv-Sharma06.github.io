import { afterEach, describe, expect, it } from 'vitest';
import { orphanedDatabases, readFlushAnswer, readStartFailure, requestFlush, restoreFailureMessage, StorageWriteError } from '@/db/client';
import { MigrationError, NewerSchemaError } from '@/db/migrate';

/**
 * The decisions of the database client (src/db/client.ts) that do not need a browser:
 * what the worker's answer to a flush request means, which databases are leftovers,
 * what a worker's start-up message says, and what a failed restore tells the person.
 */

describe('readFlushAnswer(): what the database worker said about copying to storage', () => {
  it('takes only an explicit yes as confirmation', () => {
    expect(readFlushAnswer({ op: 'flushed', id: 'a', ok: true }, 'a')).toEqual({ status: 'confirmed' });
  });

  it('reports a failed copy with the browser’s own error text', () => {
    expect(readFlushAnswer({ op: 'flushed', id: 'a', ok: false, error: 'QuotaExceededError: The quota has been exceeded.' }, 'a')).toEqual({
      status: 'failed',
      reason: 'QuotaExceededError: The quota has been exceeded.',
    });
  });

  it('does not mistake an answer without a yes for a confirmation', () => {
    expect(readFlushAnswer({ op: 'flushed', id: 'a' }, 'a')).toEqual({ status: 'failed', reason: 'no reason was given' });
    expect(readFlushAnswer({ op: 'flushed', id: 'a', ok: 'true' }, 'a')).toMatchObject({ status: 'failed' });
    expect(readFlushAnswer({ op: 'flushed', id: 'a', ok: false, error: '' }, 'a')).toEqual({ status: 'failed', reason: 'no reason was given' });
  });

  it('ignores everything that is not the answer to this request', () => {
    // the channel is shared by all tabs: other requests, and the answers to them, pass by
    expect(readFlushAnswer({ op: 'flush', id: 'a' }, 'a')).toBeNull();
    expect(readFlushAnswer({ op: 'flushed', id: 'b', ok: true }, 'a')).toBeNull();
    expect(readFlushAnswer(undefined, 'a')).toBeNull();
    expect(readFlushAnswer('flushed', 'a')).toBeNull();
    expect(readFlushAnswer(null, 'a')).toBeNull();
  });
});

describe('requestFlush(): asking the worker that hosts a database to copy it to storage', () => {
  const CONTROL = 'claude-lifetime:db-control:helpers-test';
  let hosting: BroadcastChannel | null = null;

  /** Plays the worker that hosts the database "helpers-test". */
  function host(answer: (id: string) => unknown[]) {
    const channel = new BroadcastChannel(CONTROL);
    hosting = channel;
    channel.onmessage = (event: MessageEvent<{ op?: string; id?: string }>) => {
      if (event.data?.op !== 'flush' || !event.data.id) return;
      for (const message of answer(event.data.id)) channel.postMessage(message);
    };
  }
  afterEach(() => {
    hosting?.close();
    hosting = null;
  });

  it('is confirmed when the worker says the copy was made', async () => {
    host((id) => [{ op: 'flushed', id, ok: true }]);
    expect(await requestFlush('helpers-test', 5000)).toEqual({ status: 'confirmed' });
  });

  it('has failed when the worker says the copy was not made', async () => {
    host((id) => [{ op: 'flushed', id, ok: false, error: 'QuotaExceededError: The quota has been exceeded.' }]);
    expect(await requestFlush('helpers-test', 5000)).toEqual({ status: 'failed', reason: 'QuotaExceededError: The quota has been exceeded.' });
  });

  it('is unanswered, not confirmed, when nobody answers in time', async () => {
    const started = Date.now();
    expect(await requestFlush('helpers-test', 150)).toEqual({ status: 'unanswered' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('waits for its own answer and is not settled by the answer to another tab’s request', async () => {
    host((id) => [
      { op: 'flushed', id: 'someone-else', ok: true },
      { op: 'flushed', id, ok: false, error: 'AbortError: The transaction was aborted.' },
    ]);
    expect(await requestFlush('helpers-test', 5000)).toEqual({ status: 'failed', reason: 'AbortError: The transaction was aborted.' });
  });
});

describe('readStartFailure(): the message a database worker posts when it cannot start', () => {
  it('returns the reason the worker gave', () => {
    expect(readStartFailure({ type: 'claude-lifetime:start-failed', error: 'Could not load /pglite/0.5.16/pglite.wasm.gz (HTTP 404)' })).toBe(
      'Could not load /pglite/0.5.16/pglite.wasm.gz (HTTP 404)',
    );
  });

  it('still counts as a failed start when no reason came with it', () => {
    expect(readStartFailure({ type: 'claude-lifetime:start-failed' })).toBe('The database could not be started.');
    expect(readStartFailure({ type: 'claude-lifetime:start-failed', error: '' })).toBe('The database could not be started.');
  });

  it('leaves the messages of PGlite’s own start-up alone', () => {
    for (const message of [{ type: 'here' }, { type: 'ready', id: 'x' }, { type: 'leader-now' }, undefined, null, 'ready']) {
      expect(readStartFailure(message)).toBeNull();
    }
  });
});

describe('orphanedDatabases(): which databases can be cleared away when a tab starts', () => {
  const restoring = (name: string) => `claude-lifetime:restore:${name}`;
  const listed = ['/pglite/claude-lifetime', '/pglite/claude-lifetime-mwa4r63d', '/pglite/claude-lifetime-mwa4rlxb'];

  it('keeps the active database and removes what a finished or abandoned restore left behind', () => {
    expect(orphanedDatabases(listed, ['claude-lifetime-mwa4rlxb'], new Set())).toEqual(['claude-lifetime', 'claude-lifetime-mwa4r63d']);
  });

  it('never removes a database that a restore, in any tab, is still building', () => {
    const locks = new Set([restoring('claude-lifetime-mwa4rlxb'), 'claude-lifetime:import']);
    expect(orphanedDatabases(listed, ['claude-lifetime'], locks)).toEqual(['claude-lifetime-mwa4r63d']);
  });

  it('keeps every database it was told to keep, such as the one this tab has open while the pointer names another', () => {
    expect(orphanedDatabases(listed, ['claude-lifetime', 'claude-lifetime-mwa4rlxb'], new Set())).toEqual(['claude-lifetime-mwa4r63d']);
  });

  it('removes nothing when the browser cannot say which locks are held', () => {
    // without that, a restore in progress cannot be told from a leftover
    expect(orphanedDatabases(listed, ['claude-lifetime'], null)).toEqual([]);
  });

  it('only ever names databases of this app', () => {
    const others = ['claude-lifetime-local', '/pglite/other-app', '/pglite/claude-lifetime-UPPER', '/pglite/claude-lifetime-x/y', 'unrelated', undefined];
    expect(orphanedDatabases([...others, '/pglite/claude-lifetime-old'], ['claude-lifetime'], new Set())).toEqual(['claude-lifetime-old']);
  });

  it('names each leftover once', () => {
    expect(orphanedDatabases(['/pglite/claude-lifetime-old', '/pglite/claude-lifetime-old'], ['claude-lifetime'], new Set())).toEqual(['claude-lifetime-old']);
  });
});

describe('restoreFailureMessage(): what a failed restore tells the person', () => {
  const NEWER = /made by a newer version of Claude Lifetime/;

  it('says "newer version" only when the backup holds migrations this build does not know', () => {
    const message = restoreFailureMessage(new NewerSchemaError(['20991231000000_from_a_later_release']));
    expect(message).toMatch(NEWER);
    expect(message).toMatch(/Reload the page to update, then restore it again\./);
  });

  it('says what really happened when a migration of an older backup fails', () => {
    const failure = new MigrationError('Migration "20261110000100_x" failed and was rolled back: division by zero', '20261110000100_x');
    const message = restoreFailureMessage(failure);
    expect(message).not.toMatch(NEWER);
    expect(message).toBe(
      'This backup could not be updated to work with this version of Claude Lifetime, so nothing was changed. (Migration "20261110000100_x" failed and was rolled back: division by zero)',
    );
  });

  it('passes a storage problem on as it is, because that message is already written for the person', () => {
    const message = restoreFailureMessage(new StorageWriteError('The backup could not be saved to this device’s storage.', 'QuotaExceededError'));
    expect(message).toBe('The backup could not be saved to this device’s storage.');
  });

  it('reports anything else as a backup that could not be read, with the detail in brackets', () => {
    expect(restoreFailureMessage(new Error('PGlite failed to initialize properly'))).toBe(
      'The backup could not be read, so nothing was changed. (PGlite failed to initialize properly)',
    );
    expect(restoreFailureMessage('plain text')).toBe('The backup could not be read, so nothing was changed. (plain text)');
  });
});

import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseMovedError, DatabaseUnavailableError, REREAD_ATTEMPTS, rereadIfMoved } from '@/db/driver';
import { pgliteDriver } from '@/db/pglite-driver';
import { after } from '../helpers/browser';

/**
 * What the driver does when the database that the tabs share moves to another tab's
 * worker (the tab that held it was closed or reloaded), and when the page gives a
 * connection up.
 *
 * PGlite's page class is played by a script: it records what it is asked to send, and
 * a call "to the worker" settles only when the test says so. Its transaction() does what
 * the real one does around the callback: BEGIN, then COMMIT, or ROLLBACK after an error.
 */
function scriptedPage() {
  const sent: string[] = [];
  const waiting: Array<{ sql: string; answer(): void; fail(error: Error): void }> = [];
  const listeners = new Set<() => void>();
  let connected = Promise.resolve();
  const send = (sql: string) =>
    new Promise<{ rows: unknown[]; affectedRows: number }>((resolve, reject) => {
      sent.push(sql);
      waiting.push({ sql, answer: () => resolve({ rows: [{ sql }], affectedRows: 0 }), fail: reject });
    });
  const pg = {
    get waitReady() {
      return connected;
    },
    query: (sql: string) => send(sql),
    exec: (sql: string) => send(sql),
    async transaction(callback: (tx: unknown) => Promise<unknown>) {
      await send('BEGIN');
      try {
        const result = await callback({ query: (sql: string) => send(sql), exec: (sql: string) => send(sql) });
        await send('COMMIT');
        return result;
      } catch (error) {
        await send('ROLLBACK');
        throw error;
      }
    },
  };
  return {
    pg: pg as unknown as PGliteInterface,
    sent,
    /** Answers the call that has waited longest. */
    async answer() {
      waiting.shift()!.answer();
      await after(0, null);
    },
    /** The database moves: the page class says so, and fails the calls it was waiting for. */
    async move() {
      for (const listener of [...listeners]) listener();
      for (const call of waiting.splice(0)) call.fail(new Error('Leader changed, pending operation in indeterminate state'));
      await after(0, null);
    },
    onMove(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Until the returned function is called, the page is not connected to any worker. */
    disconnect() {
      let reconnect!: () => void;
      connected = new Promise<void>((resolve) => (reconnect = resolve));
      return reconnect;
    },
    listeners,
  };
}

/** How `work` ends. Taken up at once, as the app's code does by awaiting, so that a failure is never left unobserved. */
function watch<T>(work: Promise<T>) {
  const ended = work.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  return { outcome: () => Promise.race([ended, after(200, 'still waiting' as const)]) };
}

describe('an operation that is under way when the database moves to another tab', () => {
  it('fails at once, with a message for the person, whatever becomes of the call itself', async () => {
    const page = scriptedPage();
    const db = pgliteDriver(page.pg, { onMove: page.onMove });
    const reading = watch(db.query('SELECT 1'));
    await after(0, null);
    expect(page.sent).toEqual(['SELECT 1']);

    await page.move();

    const result = await reading.outcome();
    expect(result).toMatchObject({ error: expect.any(DatabaseMovedError) });
    expect((result as { error: Error }).error.message).toBe(
      'The tab that held the database was closed or reloaded at that moment, and another tab has taken over. It is not known whether your change was stored: check, and make it again if it is missing.',
    );
    // The driver stops listening for moves once the operation is over.
    expect(page.listeners.size).toBe(1);
  });

  it('fails even when the page class is left waiting for an answer that never comes', async () => {
    const page = scriptedPage();
    const db = pgliteDriver(page.pg, { onMove: page.onMove });
    const reading = watch(db.query('SELECT 1'));
    await after(0, null);
    // What the real class does after a move: it asks the new worker, which is not listening yet, to end its turn.
    for (const listener of [...page.listeners]) listener();

    expect(await reading.outcome()).toMatchObject({ error: expect.any(DatabaseMovedError) });
  });

  it('is not failed by a move that happened before it had asked the database for anything', async () => {
    const page = scriptedPage();
    const db = pgliteDriver(page.pg, { onMove: page.onMove });
    const reconnect = page.disconnect();
    const reading = watch(db.query('SELECT 1'));
    await after(0, null);
    // Still not connected, and the database moves once more.
    await page.move();
    expect(page.sent).toEqual([]);

    reconnect();
    await after(0, null);
    await page.answer();
    expect(await reading.outcome()).toEqual({ value: { rows: [{ sql: 'SELECT 1' }], affectedRows: 0 } });
  });

  it('answers as before when nothing moves, and passes the database’s own errors on', async () => {
    const page = scriptedPage();
    const db = pgliteDriver(page.pg, { onMove: page.onMove });
    const reading = db.query('SELECT 1');
    await after(0, null);
    await page.answer();
    expect(await reading).toEqual({ rows: [{ sql: 'SELECT 1' }], affectedRows: 0 });
    expect(page.listeners.size).toBe(1);
  });
});

describe('an operation while no tab holds the database', () => {
  it('waits for the tab that takes over, but not for good: it fails with the reason this tab’s own attempt gave', async () => {
    const page = scriptedPage();
    const db = pgliteDriver(page.pg, {
      onMove: page.onMove,
      connectTimeoutMs: 40,
      whyUnavailable: () => 'Could not load /claude-lifetime/pglite/0.5.16/pglite.wasm.gz (TypeError: Failed to fetch)',
    });
    page.disconnect();
    const reading = watch(db.query('SELECT 1'));

    // Before the fix this waited for as long as the page stayed open, with nothing on screen but a spinner.
    const result = (await reading.outcome()) as { error: Error };
    expect(result.error).toBeInstanceOf(DatabaseUnavailableError);
    expect(result.error.message).toBe(
      'The database is not answering. The tab that held it was closed, and no tab has been able to open it since (Could not load /claude-lifetime/pglite/0.5.16/pglite.wasm.gz (TypeError: Failed to fetch)). Reload this page.',
    );
    expect(page.sent).toEqual([]);
  });

  it('gives up sooner once this tab’s own attempt to open the database has failed: only another tab could still do it', async () => {
    const page = scriptedPage();
    let ownFailure: string | null = null;
    const db = pgliteDriver(page.pg, { onMove: page.onMove, connectTimeoutMs: 60_000, ownFailureTimeoutMs: 60, whyUnavailable: () => ownFailure });
    page.disconnect();
    const reading = watch(db.query('SELECT 1'));
    await after(20, null);
    // The operation is waiting already when this tab's worker reports that it could not start.
    ownFailure = 'Could not load /pglite.wasm.gz (HTTP 503)';

    const result = (await reading.outcome()) as { error: Error };
    expect(result.error).toBeInstanceOf(DatabaseUnavailableError);
    expect(result.error.message).toContain('(Could not load /pglite.wasm.gz (HTTP 503))');
  });

  it('goes ahead when a tab takes over in time, and says nothing of a reason when this tab made no attempt of its own', async () => {
    const page = scriptedPage();
    const db = pgliteDriver(page.pg, { onMove: page.onMove, connectTimeoutMs: 150 });
    const reconnect = page.disconnect();
    const reading = watch(db.query('SELECT 1'));
    await after(30, null);
    reconnect();
    await after(0, null);
    await page.answer();
    expect(await reading.outcome()).toEqual({ value: { rows: [{ sql: 'SELECT 1' }], affectedRows: 0 } });

    expect(new DatabaseUnavailableError().message).toBe(
      'The database is not answering. The tab that held it was closed, and no tab has been able to open it since. Reload this page.',
    );
  });
});

describe('what a connection needs done once before it is used', () => {
  it('is done before the first operation, once, and again when a move interrupted it', async () => {
    const page = scriptedPage();
    const attempts: Array<{ work(): void; fail(error: Error): void }> = [];
    const db = pgliteDriver(page.pg, {
      onMove: page.onMove,
      prepare: () => new Promise<void>((resolve, reject) => attempts.push({ work: resolve, fail: reject })),
    });

    // The first two operations wait for one attempt. The database moves before it has worked.
    const first = watch(db.query('SELECT 1'));
    const second = watch(db.query('SELECT 2'));
    await after(0, null);
    expect(attempts).toHaveLength(1);
    expect(page.sent).toEqual([]);
    await page.move();
    expect(await first.outcome()).toMatchObject({ error: expect.any(DatabaseMovedError) });
    expect(await second.outcome()).toMatchObject({ error: expect.any(DatabaseMovedError) });

    // Before the fix nothing asked again: PGlite's page class stayed without the list types, and every
    // statement that takes a list (each batch of an import) failed until the page was loaded anew.
    const third = watch(db.query('SELECT 3'));
    await after(0, null);
    expect(attempts).toHaveLength(2);
    attempts[1].work();
    await after(0, null);
    await page.answer();
    expect(await third.outcome()).toMatchObject({ value: { rows: [{ sql: 'SELECT 3' }] } });

    // Once it has worked it is not done again, not after a move either.
    await page.move();
    const fourth = watch(db.query('SELECT 4'));
    await after(0, null);
    await page.answer();
    expect(await fourth.outcome()).toMatchObject({ value: { rows: [{ sql: 'SELECT 4' }] } });
    expect(attempts).toHaveLength(2);
  });

  it('fails the operation that needed it when it fails, and is tried again by the next one', async () => {
    const page = scriptedPage();
    let calls = 0;
    const db = pgliteDriver(page.pg, {
      onMove: page.onMove,
      prepare: async () => {
        if (++calls === 1) throw new Error('could not read pg_type');
      },
    });
    expect(await watch(db.query('SELECT 1')).outcome()).toMatchObject({ error: new Error('could not read pg_type') });
    const again = watch(db.query('SELECT 2'));
    await after(0, null);
    await page.answer();
    expect(await again.outcome()).toMatchObject({ value: { rows: [{ sql: 'SELECT 2' }] } });
    expect(calls).toBe(2);
  });
});

describe('waiting for a change to reach storage', () => {
  /** A worker's answer to "copy everything to storage", which comes when the test says so. */
  function storage() {
    let confirm!: () => void;
    const answered = new Promise<void>((resolve) => (confirm = resolve));
    return { flush: () => answered, confirm };
  }

  it('fails when the database moves before the worker that made the change has confirmed it', async () => {
    const page = scriptedPage();
    const device = storage();
    const db = pgliteDriver(page.pg, { onMove: page.onMove, flush: device.flush });
    const saving = watch(db.query('UPDATE 1'));
    await after(0, null);
    await page.answer();
    expect(await saving.outcome()).toMatchObject({ value: { affectedRows: 0 } });

    // The change is made. The tab whose worker made it is closed before that worker has copied it to storage.
    const confirming = watch(db.flush());
    await after(0, null);
    await page.move();

    // Before the fix the wait ended after a while without an answer, which the app took for "saved".
    expect(await confirming.outcome()).toMatchObject({ error: expect.any(DatabaseMovedError) });
  });

  it('succeeds when the worker confirms, and asks the worker that holds the database at that time', async () => {
    const page = scriptedPage();
    const device = storage();
    const db = pgliteDriver(page.pg, { onMove: page.onMove, flush: device.flush });
    const confirming = watch(db.flush());
    await after(0, null);
    device.confirm();
    expect(await confirming.outcome()).toEqual({ value: undefined });
    expect(page.listeners.size).toBe(1);
  });
});

describe('a transaction that is under way when the database moves', () => {
  it('fails at once and sends nothing more: no further statement, no COMMIT and no ROLLBACK', async () => {
    const page = scriptedPage();
    const db = pgliteDriver(page.pg, { onMove: page.onMove });
    let secondStatement: unknown = 'not reached';
    const saving = watch(
      db.transaction(async (tx) => {
        await tx.query('INSERT 1');
        // The code goes on although the database is gone: a statement, as an import would send the next batch.
        secondStatement = await tx.query('INSERT 2').catch((error: unknown) => error);
        return 'saved';
      }),
    );
    await after(0, null);
    await page.answer(); // BEGIN
    await page.answer(); // INSERT 1 is answered; INSERT 2 is on its way
    expect(page.sent).toEqual(['BEGIN', 'INSERT 1', 'INSERT 2']);

    await page.move();

    expect(await saving.outcome()).toMatchObject({ error: expect.any(DatabaseMovedError) });
    // Before the fix PGlite went on to send COMMIT (the callback returned), which the new worker would
    // have carried out outside any transaction.
    await after(20, null);
    expect(page.sent).toEqual(['BEGIN', 'INSERT 1', 'INSERT 2']);
    expect(secondStatement).toBeInstanceOf(Error);
  });

  it('refuses a statement the code sends after the move, without passing it on', async () => {
    const page = scriptedPage();
    const db = pgliteDriver(page.pg, { onMove: page.onMove });
    let proceed!: () => void;
    const pause = new Promise<void>((resolve) => (proceed = resolve));
    let later: unknown = 'not reached';
    const saving = watch(
      db.transaction(async (tx) => {
        await tx.exec('INSERT 1');
        await pause; // the code is busy with something else while the database moves
        later = await tx.exec('INSERT 2').catch((error: unknown) => error);
        throw new Error('gave up');
      }),
    );
    await after(0, null);
    await page.answer(); // BEGIN
    await page.answer(); // INSERT 1

    await page.move();
    proceed();
    await after(20, null);

    expect(await saving.outcome()).toMatchObject({ error: expect.any(DatabaseMovedError) });
    expect(later).toBeInstanceOf(DatabaseMovedError);
    expect(page.sent).toEqual(['BEGIN', 'INSERT 1']);
  });

  it('commits as before when nothing moves, and rolls back when the code fails', async () => {
    const page = scriptedPage();
    const db = pgliteDriver(page.pg, { onMove: page.onMove });
    const saving = db.transaction(async (tx) => {
      await tx.query('INSERT 1');
      return 'saved';
    });
    await after(0, null);
    await page.answer();
    await page.answer();
    await page.answer();
    expect(await saving).toBe('saved');

    const failing = watch(
      db.transaction(async () => {
        throw new Error('not valid');
      }),
    );
    await after(0, null);
    await page.answer();
    await page.answer();
    expect(await failing.outcome()).toMatchObject({ error: new Error('not valid') });
    expect(page.sent).toEqual(['BEGIN', 'INSERT 1', 'COMMIT', 'BEGIN', 'ROLLBACK']);
  });
});

describe('a connection the page has given up', () => {
  let pg: PGlite | null = null;
  afterEach(async () => {
    await pg?.close();
    pg = null;
  });

  it('sends nothing more, and a transaction that was under way is rolled back by its next statement', async () => {
    pg = new PGlite();
    let over = false;
    const db = pgliteDriver(pg, { isOver: () => over });
    await db.exec('CREATE TABLE notes (id integer PRIMARY KEY)');
    let proceed!: () => void;
    const pause = new Promise<void>((resolve) => (proceed = resolve));
    const saving = watch(
      db.transaction(async (tx) => {
        await tx.exec('INSERT INTO notes VALUES (1)');
        await pause;
        await tx.exec('INSERT INTO notes VALUES (2)');
      }),
    );
    await after(20, null);

    over = true;
    proceed();

    expect(await saving.outcome()).toMatchObject({ error: new Error('This connection to the database has been given up. Reload the page.') });
    await expect(db.query('SELECT 1')).rejects.toThrow('This connection to the database has been given up.');
    // The database itself is free again and holds nothing of the transaction.
    expect((await pg.query('SELECT id FROM notes')).rows).toEqual([]);
  });
});

describe('rereadIfMoved()', () => {
  it('reads again after a move, and gives up after a few moves in a row', async () => {
    let calls = 0;
    const second = await rereadIfMoved(async () => {
      if (++calls === 1) throw new DatabaseMovedError();
      return 'read';
    });
    expect(second).toBe('read');
    expect(calls).toBe(2);

    calls = 0;
    await expect(
      rereadIfMoved(async () => {
        calls++;
        throw new DatabaseMovedError();
      }),
    ).rejects.toBeInstanceOf(DatabaseMovedError);
    expect(calls).toBe(REREAD_ATTEMPTS);
  });

  it('does not repeat a read that failed for another reason', async () => {
    let calls = 0;
    await expect(
      rereadIfMoved(async () => {
        calls++;
        throw new Error('relation "x" does not exist');
      }),
    ).rejects.toThrow('relation "x" does not exist');
    expect(calls).toBe(1);
  });
});

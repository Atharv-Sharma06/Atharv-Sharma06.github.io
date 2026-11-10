'use client';

/**
 * A tiny key-value store in IndexedDB for things that cannot live in the SQL
 * database: handles to folders and files the user picked (the browser can only store
 * those in IndexedDB) and a few device-local switches. Never synced, never uploaded.
 */
const DB_NAME = 'claude-lifetime-local';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Local storage is not available.'));
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = work(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Local storage request failed.'));
    });
  } finally {
    db.close();
  }
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  try {
    return (await run('readonly', (s) => s.get(key))) as T | undefined;
  } catch {
    return undefined;
  }
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await run('readwrite', (s) => s.put(value, key));
}

export async function kvDelete(key: string): Promise<void> {
  try {
    await run('readwrite', (s) => s.delete(key));
  } catch {
    // nothing stored, nothing to remove
  }
}

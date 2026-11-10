/**
 * Passphrase protection for backup files.
 *
 * A backup is a copy of the whole local database. Inside the browser it is protected
 * by the browser's own storage isolation; as a downloaded file it is not, so it can be
 * encrypted before it leaves the app. AES-256-GCM, with the key derived from the
 * passphrase by PBKDF2-SHA-256. Everything uses the browser's Web Crypto API.
 *
 * File layout: magic "CLBK1" | 16-byte salt | 12-byte nonce | ciphertext with GCM tag.
 * The passphrase is never stored. Without it the backup cannot be opened by anyone,
 * including this app.
 */
const MAGIC = new TextEncoder().encode('CLBK1');
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const HEADER_BYTES = MAGIC.length + SALT_BYTES + NONCE_BYTES;
/** OWASP's 2023 recommendation for PBKDF2-HMAC-SHA256. */
const ITERATIONS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 8;

export class BackupCryptoError extends Error {
  constructor(
    message: string,
    readonly code: 'passphrase_required' | 'wrong_passphrase' | 'weak_passphrase' | 'damaged',
  ) {
    super(message);
    this.name = 'BackupCryptoError';
  }
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: ITERATIONS },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function isEncryptedBackup(blob: Blob): Promise<boolean> {
  if (blob.size < HEADER_BYTES) return false;
  const head = new Uint8Array(await blob.slice(0, MAGIC.length).arrayBuffer());
  return MAGIC.every((byte, i) => head[i] === byte);
}

export async function encryptBackup(backup: Blob, passphrase: string): Promise<Blob> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new BackupCryptoError(`Use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`, 'weak_passphrase');
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const key = await deriveKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, await backup.arrayBuffer());
  return new Blob([MAGIC as BlobPart, salt as BlobPart, nonce as BlobPart, ciphertext], { type: 'application/octet-stream' });
}

export async function decryptBackup(encrypted: Blob, passphrase: string | undefined): Promise<Blob> {
  if (!passphrase) throw new BackupCryptoError('This backup is protected with a passphrase. Enter it to restore the backup.', 'passphrase_required');
  const bytes = new Uint8Array(await encrypted.arrayBuffer());
  if (bytes.length <= HEADER_BYTES) throw new BackupCryptoError('The backup file is incomplete.', 'damaged');
  const salt = bytes.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
  const nonce = bytes.subarray(MAGIC.length + SALT_BYTES, HEADER_BYTES);
  const key = await deriveKey(passphrase, salt);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, bytes.subarray(HEADER_BYTES) as BufferSource);
    return new Blob([plain], { type: 'application/gzip' });
  } catch {
    // GCM authenticates the data: a wrong passphrase and a modified file fail the same way.
    throw new BackupCryptoError('The passphrase does not match this backup, or the file was changed after it was saved.', 'wrong_passphrase');
  }
}

import { describe, expect, it } from 'vitest';
import { BackupCryptoError, decryptBackup, encryptBackup, isEncryptedBackup } from '@/lib/backup-crypto';

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
const sample = () => new Blob([new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 250, 251, 252]) as unknown as BlobPart]);

describe('backup encryption', () => {
  it('round-trips a backup with the right passphrase', async () => {
    const encrypted = await encryptBackup(sample(), 'correct horse battery');
    expect(await isEncryptedBackup(encrypted)).toBe(true);
    expect(await isEncryptedBackup(sample())).toBe(false);
    const restored = await decryptBackup(encrypted, 'correct horse battery');
    expect(await bytesOf(restored)).toEqual(await bytesOf(sample()));
  });

  it('does not contain the plain bytes, and differs on every run', async () => {
    const plain = await bytesOf(sample());
    const a = await bytesOf(await encryptBackup(sample(), 'correct horse battery'));
    const b = await bytesOf(await encryptBackup(sample(), 'correct horse battery'));
    expect(Buffer.from(a).includes(Buffer.from(plain.subarray(4)))).toBe(false);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('rejects a wrong passphrase, a missing passphrase and a modified file with distinct errors', async () => {
    const encrypted = await encryptBackup(sample(), 'correct horse battery');
    await expect(decryptBackup(encrypted, 'wrong passphrase')).rejects.toMatchObject({ code: 'wrong_passphrase' });
    await expect(decryptBackup(encrypted, undefined)).rejects.toMatchObject({ code: 'passphrase_required' });
    const tampered = await bytesOf(encrypted);
    tampered[tampered.length - 1] ^= 1;
    await expect(decryptBackup(new Blob([tampered as unknown as BlobPart]), 'correct horse battery')).rejects.toBeInstanceOf(BackupCryptoError);
    await expect(decryptBackup(new Blob([tampered.subarray(0, 20) as unknown as BlobPart]), 'correct horse battery')).rejects.toMatchObject({ code: 'damaged' });
  });

  it('refuses a passphrase that is too short', async () => {
    await expect(encryptBackup(sample(), 'short')).rejects.toMatchObject({ code: 'weak_passphrase' });
  });
});

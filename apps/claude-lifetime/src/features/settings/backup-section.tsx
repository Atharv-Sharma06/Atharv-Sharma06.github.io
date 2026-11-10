'use client';

import { Check, CircleCheck, CircleDashed, Download, Upload } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/controls';
import { ErrorNote, Skeleton } from '@/components/ui/feedback';
import { Dialog, InfoTip } from '@/components/ui/overlay';
import { restoreDatabase } from '@/db/client';
import { BackupCryptoError, encryptBackup, isEncryptedBackup, MIN_PASSPHRASE_LENGTH } from '@/lib/backup-crypto';
import { formatBytes, formatInt, plural } from '@/lib/format';
import { useApp, useData } from '@/state/app';
import { useCoverage } from '@/state/queries';
import { backupFileName, checkPassphrase, looksLikeDatabaseDump } from './logic';
import { SettingRow, SettingsSection } from './parts';

interface StorageInfo {
  /** Bytes this site uses and may use, as far as the browser tells. Null when it does not. */
  usage: number | null;
  quota: number | null;
  /** Whether the browser has promised not to clear the data on its own. Null when it cannot say. */
  persisted: boolean | null;
  canAsk: boolean;
}

async function readStorage(): Promise<StorageInfo> {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
  const info: StorageInfo = { usage: null, quota: null, persisted: null, canAsk: typeof storage?.persist === 'function' };
  try {
    if (typeof storage?.estimate === 'function') {
      const estimate = await storage.estimate();
      info.usage = estimate.usage ?? null;
      info.quota = estimate.quota ?? null;
    }
    if (typeof storage?.persisted === 'function') info.persisted = await storage.persisted();
  } catch {
    // a browser that blocks the storage API reports nothing; the row then says so
  }
  return info;
}

// ── Storage ─────────────────────────────────────────────────────────────────────

function StorageRow() {
  const storage = useData(['settings', 'storage'], () => readStorage());
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<'granted' | 'refused' | 'failed' | null>(null);
  const info = storage.data;

  const ask = async () => {
    setAsking(true);
    try {
      setAnswer((await navigator.storage.persist()) ? 'granted' : 'refused');
    } catch {
      setAnswer('failed');
    }
    await storage.refetch();
    setAsking(false);
  };

  return (
    <SettingRow
      id="storage"
      title="Storage on this device"
      description={
        <p>How much space the site takes in this browser, and whether the browser may clear it on its own when the device runs low on space.</p>
      }
    >
      {!info ? (
        <div aria-busy="true" className="space-y-2">
          <Skeleton className="h-5 w-64 max-w-full" />
          <Skeleton className="h-5 w-80 max-w-full" />
        </div>
      ) : (
        <>
          <dl className="space-y-2.5 text-[13px]">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <dt className="text-ink-2">Used by this site</dt>
              <dd className="flex items-center gap-1.5 text-ink">
                {info.usage === null ? (
                  <span className="text-ink-2">This browser does not report it.</span>
                ) : (
                  <>
                    <span className="tabular">about {formatBytes(info.usage)}</span>
                    {info.quota !== null ? <span className="text-ink-2">of the {formatBytes(info.quota)} the browser allows</span> : null}
                    <InfoTip label="About this figure">
                      <p>
                        Browsers report storage per site, and only approximately. The figure covers everything stored for {window.location.host},
                        not just this database.
                      </p>
                    </InfoTip>
                  </>
                )}
              </dd>
            </div>
            <div className="flex flex-wrap items-start gap-x-2 gap-y-0.5">
              <dt className="text-ink-2">Protected from automatic clean-up</dt>
              <dd className="text-ink">
                {info.persisted === true ? (
                  <span className="inline-flex items-center gap-1.5">
                    <CircleCheck className="size-4 text-good" strokeWidth={2.25} aria-hidden="true" />
                    Yes. The browser only removes this data when you clear it yourself.
                  </span>
                ) : info.persisted === false ? (
                  <span className="inline-flex items-start gap-1.5">
                    <CircleDashed className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={2.25} aria-hidden="true" />
                    Not yet. The browser may clear it if the device runs very low on space.
                  </span>
                ) : (
                  <span className="text-ink-2">This browser does not say.</span>
                )}
              </dd>
            </div>
          </dl>

          {info.persisted === false && info.canAsk ? (
            <div className="mt-3.5">
              <Button onClick={() => void ask()} loading={asking}>
                Ask the browser to keep this data
              </Button>
            </div>
          ) : null}
          <p aria-live="polite" className="mt-2.5 max-w-[68ch] text-[13px] text-ink-2 empty:hidden">
            {answer === 'granted' ? 'The browser agreed: this data is now kept until you remove it yourself.' : null}
            {answer === 'refused'
              ? 'The browser declined. It decides this on its own, for example by how often you use the site or whether it is bookmarked or installed, and gives no reason. Your data stays where it is; a downloaded backup is the safe copy.'
              : null}
            {answer === 'failed' ? 'The browser did not answer the request. Your data stays where it is; a downloaded backup is the safe copy.' : null}
          </p>
        </>
      )}
    </SettingRow>
  );
}

// ── Download ────────────────────────────────────────────────────────────────────

function DownloadRow() {
  const app = useApp();
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [problem, setProblem] = useState<{ field: 'passphrase' | 'repeat'; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ name: string; size: number; encrypted: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const second = useRef<HTMLInputElement>(null);

  const download = async () => {
    setError(null);
    setDone(null);
    const check = checkPassphrase(passphrase, repeat, MIN_PASSPHRASE_LENGTH);
    if (!check.ok) {
      setProblem({ field: check.field, message: check.message });
      (check.field === 'passphrase' ? first : second).current?.focus();
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      // A complete sentence for the person when it fails: no backup is made of anything but a clean copy of the stored rows.
      const plain = await app.exportBackup();
      const encrypted = check.passphrase !== null;
      let backup = plain;
      if (check.passphrase !== null) {
        try {
          backup = await encryptBackup(plain, check.passphrase);
        } catch (e) {
          throw new Error(`The backup could not be encrypted, so nothing was downloaded. (${e instanceof Error ? e.message : String(e)})`);
        }
      }
      const name = backupFileName(new Date(), encrypted);
      const url = URL.createObjectURL(backup);
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.hidden = true;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // The browser reads the file from this address when the download starts; release it once that has had time to happen.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setDone({ name, size: backup.size, encrypted });
      // The passphrase has done its job and is not kept, not even in these fields.
      setPassphrase('');
      setRepeat('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingRow
      id="download-backup"
      title="Download backup"
      description={
        <p>
          One file with everything the app stores now: titles, dates and token figures, together with your subscription history, the prices you
          entered and your settings. It holds no message text, and nothing of what you have deleted.
        </p>
      }
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void download();
        }}
      >
        <div className="grid max-w-[38rem] gap-x-3 gap-y-3 sm:grid-cols-2">
          <Field label="Passphrase (optional)" error={problem?.field === 'passphrase' ? problem.message : null}>
            <Input
              ref={first}
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value);
                setProblem(null);
              }}
              aria-invalid={problem?.field === 'passphrase' ? true : undefined}
            />
          </Field>
          <Field label="Repeat passphrase" error={problem?.field === 'repeat' ? problem.message : null}>
            <Input
              ref={second}
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(e) => {
                setRepeat(e.target.value);
                setProblem(null);
              }}
              aria-invalid={problem?.field === 'repeat' ? true : undefined}
            />
          </Field>
        </div>
        <p className="mt-2.5 max-w-[68ch] text-[13px] text-ink-2">
          Without a passphrase, anyone who has the file can read it. With one, the file is encrypted on this device before it is saved. The passphrase
          is never stored, so a forgotten passphrase cannot be recovered.
        </p>
        <Button type="submit" className="mt-3.5" loading={busy}>
          {busy ? null : <Download className="size-4" aria-hidden="true" />}
          {busy ? 'Preparing the backup…' : 'Download backup'}
        </Button>
      </form>
      <div aria-live="polite">
        {done ? (
          <p className="mt-2.5 flex items-start gap-1.5 text-[13px] text-ink-2">
            <Check className="mt-0.5 size-3.5 shrink-0 text-good" strokeWidth={2.5} aria-hidden="true" />
            <span className="min-w-0 break-words">
              Handed to your browser as <span className="text-ink">{done.name}</span> ({formatBytes(done.size)},{' '}
              {done.encrypted ? 'encrypted with your passphrase' : 'not encrypted'}). Look for it in your downloads.
            </span>
          </p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-2.5 max-w-[68ch] text-[13px] text-critical [overflow-wrap:anywhere]">
          {error}
        </p>
      ) : null}
    </SettingRow>
  );
}

// ── Restore ─────────────────────────────────────────────────────────────────────

/**
 * The last step before a restore. Built on Dialog rather than ConfirmDialog because a
 * protected backup needs a passphrase field whose error belongs next to it, and a wrong
 * passphrase must leave the dialog open for another try.
 */
function RestoreDialog({ file, encrypted, onClose }: { file: File; encrypted: boolean; onClose: () => void }) {
  const { settings } = useApp();
  const coverage = useCoverage();
  const formId = useId();
  const field = useRef<HTMLInputElement>(null);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [passphraseError, setPassphraseError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const sources = coverage.data?.sources ?? [];
  const conversations = sources.reduce((sum, s) => sum + s.conversations, 0);

  const restore = async () => {
    setBusy(true);
    setPassphraseError(null);
    setFailure(null);
    try {
      await restoreDatabase(file, encrypted ? passphrase : undefined);
    } catch (error) {
      if (error instanceof BackupCryptoError && error.code !== 'damaged') {
        setPassphraseError(error.message);
        window.requestAnimationFrame(() => field.current?.select());
      } else {
        setFailure(error instanceof Error ? error.message : String(error));
      }
      setBusy(false);
      return;
    }
    // The dialog stays busy while the page reloads into the restored database.
    window.location.reload();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title="Replace everything with this backup?"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="danger" loading={busy}>
            Replace with backup
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="space-y-3 text-ink-2"
        onSubmit={(e) => {
          e.preventDefault();
          void restore();
        }}
      >
        <p className="break-words">
          <span className="text-ink">{file.name}</span>, {formatBytes(file.size)}, last changed{' '}
          {new Date(file.lastModified).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: settings.timezone })}
          {encrypted ? '. It is protected with a passphrase.' : '.'}
        </p>
        <p>
          Restoring <strong className="font-medium text-ink">replaces everything stored on this device</strong> with the contents of this file:
          imports, subscription history, prices you entered and settings.{' '}
          {sources.length > 0
            ? `The device currently holds ${plural(sources.length, 'source')}${conversations > 0 ? ` with ${formatInt(conversations)} conversations` : ''}.`
            : 'Nothing is imported here at the moment.'}
        </p>
        <p>
          The backup is first unpacked into a separate database and checked. Your current data is only replaced once that has worked, so a file
          that cannot be read{encrypted ? ', or a wrong passphrase,' : ''} changes nothing. Afterwards this page reloads, and so does every other
          open tab of the app.
        </p>
        {encrypted ? (
          <Field label="Passphrase for this backup" error={passphraseError} className="pt-1">
            <Input
              ref={field}
              type="password"
              autoComplete="current-password"
              autoFocus
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value);
                setPassphraseError(null);
              }}
              aria-invalid={passphraseError ? true : undefined}
            />
          </Field>
        ) : null}
      </form>
      {failure ? (
        <ErrorNote title="The backup was not restored" className="mt-4">
          {failure}
        </ErrorNote>
      ) : null}
    </Dialog>
  );
}

function RestoreRow() {
  const input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<{ file: File; encrypted: boolean } | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (file: File | undefined) => {
    setError(null);
    if (!file) return;
    setChecking(true);
    try {
      const encrypted = await isEncryptedBackup(file);
      // A protected backup can only be looked into with its passphrase; a plain one is checked here and now.
      if (!encrypted && !(await looksLikeDatabaseDump(file))) {
        setError(`“${file.name}” is not a Claude Lifetime backup. Choose the .tar.gz or .clbackup file that “Download backup” saved.`);
        return;
      }
      setPicked({ file, encrypted });
    } catch (e) {
      setError(`“${file.name}” could not be read: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setChecking(false);
    }
  };

  return (
    <SettingRow
      id="restore-backup"
      title="Restore from backup"
      description={
        <p>
          Replaces everything stored on this device with the contents of a backup file. What is here now is removed, so download a backup first if
          you might want it back.
        </p>
      }
    >
      <input
        ref={input}
        type="file"
        accept=".gz,.tgz,.clbackup,application/gzip,application/x-gzip"
        aria-label="Backup file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared so that choosing the same file again is still noticed.
          e.target.value = '';
          void choose(file);
        }}
      />
      <Button onClick={() => input.current?.click()} loading={checking}>
        {checking ? null : <Upload className="size-4" aria-hidden="true" />}
        {checking ? 'Checking the file…' : 'Choose a backup file'}
      </Button>
      <p className="mt-2.5 max-w-[68ch] text-[13px] text-ink-2">
        A .tar.gz file, or a passphrase-protected .clbackup file, made by “Download backup”. You are asked to confirm first, and a file that cannot be
        read changes nothing.
      </p>
      {error ? (
        <p role="alert" className="mt-2 max-w-[68ch] text-[13px] text-critical">
          {error}
        </p>
      ) : null}

      {picked ? <RestoreDialog file={picked.file} encrypted={picked.encrypted} onClose={() => setPicked(null)} /> : null}
    </SettingRow>
  );
}

export function BackupSection() {
  return (
    <SettingsSection
      id="backup"
      title="Backup and storage"
      description={
        <>
          <p>
            Everything you import is kept in this browser’s own storage (IndexedDB), on this device only. The app keeps metadata such as titles, dates,
            sizes and token counts; it never stores the text of your messages. Nothing is sent anywhere.
          </p>
          <p>Clearing the site data for this site in your browser deletes all of it, which is why a backup is worth having.</p>
        </>
      }
    >
      <Card className="divide-y divide-line">
        <StorageRow />
        <DownloadRow />
        <RestoreRow />
      </Card>
    </SettingsSection>
  );
}

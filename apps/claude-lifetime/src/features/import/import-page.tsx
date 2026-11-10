'use client';

import { CalendarRange, FileJson, FileSpreadsheet, FolderOpen, Keyboard, MessagesSquare, SquareTerminal, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ManualUsageResult } from '@/analytics/settings';
import { ConfidenceBadge } from '@/components/data/confidence';
import { LoadDemoButton } from '@/components/data/no-data';
import { PageHeader } from '@/components/shell/page-header';
import { Button, buttonClass } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input, Switch } from '@/components/ui/controls';
import { BASE_PATH } from '@/db/client';
import { GENERIC_FIELDS } from '@/import/generic/fields';
import { sourceRefFromName } from '@/import/generic/source-ref';
import { toImportFiles } from '@/import/session';
import { formatRelative, plural } from '@/lib/format';
import { useApp } from '@/state/app';
import { useCoverage } from '@/state/queries';
import { lastSync, syncClaudeCodeFolder, type SyncOutcome } from './background-sync';
import { ImportHistory } from './history';
import {
  autoSyncEnabled,
  autoSyncStoppedAt,
  canPickFolders,
  forgetFolder,
  pickClaudeCodeFolder,
  rememberComputerName,
  rememberedComputerName,
  rememberedFolder,
  setAutoSync,
  type RememberedFolder,
} from './local-files';
import { ManualEntryDialog } from './manual-entry';
import { Notice } from './preview';
import { ImportWizard, type WizardHandle } from './wizard';

function Option({
  icon: Icon,
  title,
  badge,
  children,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  badge?: ReactNode;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <Card className="flex flex-col px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="flex items-center gap-2 text-[15px] font-medium text-ink">
          <Icon className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
          {title}
        </h3>
        {badge}
      </div>
      <div className="mt-2 space-y-2 text-[13px] text-ink-2">{children}</div>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">{actions}</div>
    </Card>
  );
}

const Code = ({ children }: { children: ReactNode }) => <code className="rounded bg-raised px-1 py-0.5 text-[12px] text-ink">{children}</code>;

function downloadText(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * The reference of the source a named computer's usage is filed under. Made from the name in
 * whatever script it is written, so two names never share a reference because neither has an
 * ASCII letter; a name is cut to 40 characters, as it always was.
 */
const computerRef = (name: string) => sourceRefFromName(Array.from(name.trim()).slice(0, 40).join(''));

export function ImportPage() {
  const app = useApp();
  const coverage = useCoverage();
  const wizard = useRef<WizardHandle>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const [idle, setIdle] = useState(true);
  const [manualOpen, setManualOpen] = useState(false);
  /** How the last manual entry was saved, while there is something to say about it. */
  const [manualSaved, setManualSaved] = useState<ManualUsageResult | null>(null);
  const [computer, setComputer] = useState('');
  const [folder, setFolder] = useState<RememberedFolder | null>(null);
  const [auto, setAuto] = useState(false);
  const [autoStoppedAt, setAutoStoppedAt] = useState<number | null>(null);
  const [sync, setSync] = useState<SyncOutcome | null>(null);
  /** Why the last click on "Read the folder again" did not read it. Not a reading, so it is kept apart from `sync`. */
  const [notRead, setNotRead] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  // What this device remembers about the Claude Code folder lives outside React (IndexedDB); it is read on
  // mount and again whenever something on this page changes it.
  const [folderVersion, setFolderVersion] = useState(0);
  const refreshFolder = useCallback(() => setFolderVersion((v) => v + 1), []);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([rememberedFolder(), autoSyncEnabled(), lastSync(), autoSyncStoppedAt()]).then(([remembered, enabled, outcome, stoppedAt]) => {
      if (cancelled) return;
      setFolder(remembered);
      setAuto(enabled);
      setSync(outcome ?? null);
      setAutoStoppedAt(stoppedAt);
    });
    return () => {
      cancelled = true;
    };
  }, [folderVersion]);

  // The webkitdirectory attribute is not in React's typings; it turns the input into a folder picker.
  useEffect(() => folderInput.current?.setAttribute('webkitdirectory', ''), []);

  // The computer's name decides which source its usage is filed under, so it is remembered between visits:
  // typed once, the same logs keep going to the same source.
  useEffect(() => {
    let cancelled = false;
    void rememberedComputerName().then((name) => {
      if (!cancelled && name !== '') setComputer((current) => (current === '' ? name : current));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const claudeCodeOptions = () => {
    const name = computer.trim();
    void rememberComputerName(name);
    return name ? { sourceLabel: `Claude Code (${name})`, sourceRef: computerRef(name) || 'local' } : {};
  };

  const begin = (run: () => void) => {
    top.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    run();
  };

  const chooseFolder = async () => {
    setPickError(null);
    if (!canPickFolders()) {
      folderInput.current?.click();
      return;
    }
    try {
      const options = claudeCodeOptions();
      const picked = await pickClaudeCodeFolder(options);
      if (!picked) return;
      refreshFolder();
      begin(() => wizard.current?.start(picked.files, options));
    } catch (error) {
      setPickError(
        error instanceof Error && error.name === 'SecurityError'
          ? 'The browser did not allow reading that folder. Choose the “projects” folder inside it, or copy that folder somewhere else first.'
          : `The folder could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    setNotRead(null);
    try {
      const result = await syncClaudeCodeFolder(app.db, app.userId, true);
      if (result.status === 'done') {
        if (!result.outcome.problem) app.notifyDataChanged();
        refreshFolder();
      } else {
        // No attempt was made. Each reason gets its own words; none of them is recorded as a reading.
        setNotRead(
          result.status === 'busy'
            ? 'Another import is running or waiting to be saved, in this tab or another one. The folder was not read. Try again when that import is done.'
            : result.status === 'no_permission'
              ? `The browser did not grant access to “${result.folder}”, so the folder was not read. Choose the folder again to continue.`
              : 'No folder is remembered on this device any more. Choose the folder again.',
        );
        if (result.status === 'no_folder') refreshFolder();
      }
    } catch (error) {
      setNotRead(`The folder was not read: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSyncing(false);
    }
  };

  const csvTemplate = `${GENERIC_FIELDS.join(',')}\n`;

  return (
    <div>
      <PageHeader
        title="Recover Your Claude History"
        description="Anthropic does not offer a lifetime token count for a Claude account. What exists is spread over files you can get yourself: the claude.ai export, Claude Code logs and API reports. Import them here; each one is checked and previewed before it is saved."
      />

      <div ref={top} className="scroll-mt-20">
        <ImportWizard ref={wizard} onStageChange={setIdle} />
      </div>

      {coverage.data && !coverage.data.hasData && idle ? (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink-2">
          <span>No files at hand? See how the app works with synthetic data first.</span>
          <LoadDemoButton />
        </div>
      ) : null}

      <section aria-labelledby="sources-heading" className="mt-9">
        <h2 id="sources-heading" className="text-[17px] font-medium text-ink">
          Where your history can come from
        </h2>
        <p className="mt-1 max-w-[76ch] text-ink-2">
          Sources differ in what they record. Token counts metered by a source are exact; counts reconstructed from text are estimates and stay labelled
          as such.
        </p>

        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Option
            icon={MessagesSquare}
            title="claude.ai account export"
            badge={<ConfidenceBadge level="estimated" />}
            actions={
              <Button disabled={!idle} onClick={() => begin(() => wizard.current?.chooseFiles('.zip,.json,application/zip,application/json'))}>
                Choose the export
              </Button>
            }
          >
            <p>
              Your chats from the web, desktop and mobile apps. On claude.ai or in Claude Desktop open Settings, then Privacy, and choose “Export data”.
              Anthropic emails a download link that expires after 24 hours.
            </p>
            <p>
              Choose the ZIP as downloaded. It holds conversations and dates but no token counts and no model names, so tokens are estimated from the
              text. Conversations you deleted are not in it.
            </p>
          </Option>

          <Option
            icon={SquareTerminal}
            title="Claude Code sessions"
            badge={<ConfidenceBadge level="exact" />}
            actions={
              <>
                <Button disabled={!idle} onClick={() => void chooseFolder()}>
                  <FolderOpen className="size-4" aria-hidden="true" />
                  Choose the folder
                </Button>
                <a href={`${BASE_PATH}/tools/claude-lifetime-collect.mjs`} download className={buttonClass('ghost')}>
                  Download collector script
                </a>
              </>
            }
          >
            <p>
              Claude Code logs every model response with its exact token usage. Choose its folder: <Code>.claude</Code> in your home folder, or the{' '}
              <Code>projects</Code> folder inside it. Hidden folders appear in the file dialog with Cmd+Shift+. on macOS and Ctrl+H on Linux.
            </p>
            <p>
              Claude Code deletes transcripts after 30 days unless <Code>cleanupPeriodDays</Code> is raised in its settings. To keep a permanent record, run
              the collector script with Node (<Code>node claude-lifetime-collect.mjs</Code>): it copies the usage figures, never the conversation text,
              into a ledger file that you import here like any other file.
            </p>
            <Field label="Name of this computer" hint="Optional. Keeps logs from several computers apart.">
              <Input value={computer} onChange={(e) => setComputer(e.target.value)} placeholder="This computer" maxLength={40} />
            </Field>
            {pickError ? (
              <p role="alert" className="text-critical">
                {pickError}
              </p>
            ) : null}
            <input
              ref={folderInput}
              type="file"
              multiple
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                const files = toImportFiles(Array.from(e.target.files ?? []));
                e.target.value = '';
                if (files.length > 0) begin(() => wizard.current?.start(files, claudeCodeOptions()));
              }}
            />
          </Option>

          <Option
            icon={FileJson}
            title="Anthropic API usage reports"
            badge={<ConfidenceBadge level="exact" />}
            actions={
              <Button disabled={!idle} onClick={() => begin(() => wizard.current?.chooseFiles('.json,.jsonl,.csv,application/json,text/csv'))}>
                Choose report files
              </Button>
            }
          >
            <p>
              For usage billed through the Claude Developer Platform. In the Claude Console, export the Usage and Cost pages as CSV. With an organization
              admin key you can also save the JSON responses of the Admin API&rsquo;s usage and cost report endpoints; select all pages of a report
              together.
            </p>
            <p>
              The Admin API is not available to individual accounts. Cost reports are stored as money actually billed and are kept apart from the
              hypothetical API value of your other usage.
            </p>
          </Option>

          <Option
            icon={FileSpreadsheet}
            title="CSV or JSON table"
            actions={
              <>
                <Button disabled={!idle} onClick={() => begin(() => wizard.current?.chooseFiles('.csv,.tsv,.json,.jsonl,text/csv,application/json'))}>
                  Choose a file
                </Button>
                <Button variant="ghost" onClick={() => downloadText('claude-lifetime-usage-template.csv', csvTemplate, 'text/csv')}>
                  Download CSV template
                </Button>
              </>
            }
          >
            <p>
              For usage you tracked yourself or exported from another tool: one row per request or per day, with a date and token counts. You match the
              columns before anything is read, and you say whether the counts are exact or estimates.
            </p>
            <p>The template lists every column the importer understands. Only a date and one token column are required.</p>
          </Option>

          <Option
            icon={Keyboard}
            title="Add usage by hand"
            actions={
              <Button disabled={!idle} onClick={() => setManualOpen(true)}>
                Add an entry
              </Button>
            }
          >
            <p>
              For a figure you can read but not export, such as a number on a usage page. Each entry is one day, is stored as its own import and can be
              deleted again.
            </p>
          </Option>

          <Option
            icon={CalendarRange}
            title="Subscription history"
            actions={
              <Link href="/subscriptions/" className={buttonClass('secondary')}>
                Enter your plans
              </Link>
            }
          >
            <p>
              No export says when you were on Free, Pro or Max. Enter the dates yourself and every chart can split your usage by plan, including before
              and after your first subscription.
            </p>
          </Option>
        </div>
      </section>

      {folder ? (
        <section aria-labelledby="sync-heading" className="mt-9">
          <h2 id="sync-heading" className="text-[17px] font-medium text-ink">
            Keep Claude Code usage up to date
          </h2>
          <Card className="mt-4 px-5 py-4">
            <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
              <div className="min-w-0 max-w-[70ch] text-[13px] text-ink-2">
                <p className="text-sm text-ink">
                  The folder “{folder.name}” is remembered on this device.
                  {sync
                    ? sync.problem
                      ? ` The last attempt to read it, ${formatRelative(sync.at)}, did not work.`
                      : ` Last read ${formatRelative(sync.at)}, ${plural(sync.added, 'new model request')} added.`
                    : ''}
                </p>
                <p className="mt-1">
                  Its usage is stored under the source “{folder.source.sourceLabel ?? 'Claude Code (this computer)'}”, and reading it again adds to that
                  same source.
                </p>
                <p className="mt-1">
                  Reading it again adds only sessions that are new since the last time. The browser asks for permission before the app may read the
                  folder; if you allow it on every visit, the switch below lets the app do this by itself whenever you open it.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" loading={syncing} disabled={!idle} onClick={() => void syncNow()}>
                  Read the folder again
                </Button>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    await forgetFolder();
                    setNotRead(null);
                    refreshFolder();
                  }}
                >
                  Forget this folder
                </Button>
              </div>
            </div>
            <label className="mt-4 flex items-center gap-3 border-t border-line pt-4 text-[13px] text-ink">
              <Switch
                label="Read the folder automatically when the app opens"
                checked={auto}
                onChange={async (checked) => {
                  setAuto(checked);
                  setAutoStoppedAt(null);
                  await setAutoSync(checked);
                }}
              />
              <span>
                Read the folder automatically when the app opens
                <span className="block text-xs text-ink-3">
                  Only runs while the browser already allows access ({folder.permission === 'granted' ? 'it does right now' : 'it currently asks first'}).
                  New usage is saved without a preview and appears in the import history.
                </span>
              </span>
            </label>
            {autoStoppedAt !== null && !auto ? (
              <div className="mt-3">
                <Notice>
                  Automatic reading was switched off {formatRelative(autoStoppedAt)}, when Claude Code usage was deleted. Left on, it would have added
                  the deleted usage again the next time the app opened. Switch it back on whenever you want the folder read by itself again.
                </Notice>
              </div>
            ) : null}
            {(notRead ?? sync?.problem) ? (
              <div className="mt-3" role="status">
                <Notice tone="warning">{notRead ?? sync?.problem}</Notice>
              </div>
            ) : null}
          </Card>
        </section>
      ) : null}

      {manualSaved && (manualSaved.removedDemoData || manualSaved.notOnDevice) ? (
        <div className="mt-9 space-y-3" role="status">
          {manualSaved.notOnDevice ? (
            <Notice tone="warning">
              <strong className="font-medium text-ink">The entry is saved, but could not be written to this device&rsquo;s storage.</strong> It is
              in the figures now and can be lost when the app is closed. {manualSaved.notOnDevice} Do not enter it a second time: it would be counted
              twice.
            </Notice>
          ) : null}
          {manualSaved.removedDemoData ? <Notice>The synthetic demo data was removed. Everything you see from now on is your own.</Notice> : null}
        </div>
      ) : null}

      <div className="mt-9">
        <ImportHistory autoSync={folder !== null && auto} locked={!idle} onDeleted={refreshFolder} />
      </div>

      <ManualEntryDialog open={manualOpen} onOpenChange={setManualOpen} onSaved={setManualSaved} />
    </div>
  );
}

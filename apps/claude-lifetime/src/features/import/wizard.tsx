'use client';

import { CircleCheck, FileUp } from 'lucide-react';
import Link from 'next/link';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ConfidenceBadge } from '@/components/data/confidence';
import { Button, buttonClass } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ErrorNote, Progress } from '@/components/ui/feedback';
import { ImportError, type ImportFile, type ImportProgress } from '@/core/types';
import type { CommitResult } from '@/import/commit';
import type { Detected } from '@/import/detect';
import { FORMATS } from '@/import/formats';
import { questionBeforeReading } from '@/import/generic/questions';
import { ImportSession, toImportFiles, type PreparedImport } from '@/import/session';
import { cn } from '@/lib/cn';
import { formatBytes, formatInt, plural } from '@/lib/format';
import { useApp } from '@/state/app';
import { ConfidenceForm, CsvMappingForm } from './csv-mapping';
import { filesFromDrop } from './dropped-files';
import { ImportPreviewView, Notice } from './preview';

type Stage =
  | { name: 'idle' }
  | { name: 'detecting'; what: string }
  | { name: 'mapping'; files: ImportFile[]; detected: Detected }
  | { name: 'confidence'; files: ImportFile[]; detected: Detected }
  | { name: 'parsing'; detected: Detected; progress: ImportProgress | null }
  | { name: 'preview'; prepared: PreparedImport }
  | { name: 'saving'; prepared: PreparedImport }
  | { name: 'done'; prepared: PreparedImport; result: CommitResult }
  | { name: 'error'; message: string; code: string; details?: string };

/** What to do about an error, by its code. The message itself already says what went wrong. */
const NEXT_STEP: Record<string, string> = {
  zip_truncated: 'Request a new export on claude.ai and download it again; the link in the email works only for a short time.',
  truncated_file: 'Request a new export on claude.ai and download it again; the link in the email works only for a short time.',
  range_conflict: 'A report that runs from midnight to midnight (UTC), over whole days, can always replace what is stored for those days.',
  no_conversations_file: 'Choose the ZIP exactly as it was downloaded, or the conversations.json inside it.',
  no_usage_found: 'Claude Code keeps transcripts for 30 days unless you raise cleanupPeriodDays in its settings. Usage older than that can only come from the collector ledger.',
  import_in_progress: 'Only one import can be prepared at a time, because all tabs share one database.',
  mixed_sources: 'Files can be read in one import when they all name the same source, or when none of them names one.',
  stale_preview: 'Start the import again. The preview has to be recomputed against what is stored now.',
  worker_failed: 'Reload the page and try again. If the file is very large, close other tabs first to free memory.',
  demo_requires_empty_workspace: 'Remove your imported data in Settings first if you want to see the demo again.',
};

export interface WizardHandle {
  /** Starts an import with files picked elsewhere on the page. */
  start(files: ImportFile[], options?: Record<string, unknown>): void;
  /** Opens the file picker. */
  chooseFiles(accept?: string): void;
  busy: boolean;
}

function describeSelection(files: ImportFile[]): string {
  if (files.length === 1) return files[0].name;
  return `${formatInt(files.length)} files`;
}

/**
 * The import flow: validate, detect the format, preview what is new and what is
 * missing, and save only after the user confirms. Nothing is stored before "Save".
 */
export const ImportWizard = forwardRef<WizardHandle, { onStageChange?: (idle: boolean) => void }>(function ImportWizard({ onStageChange }, ref) {
  const app = useApp();
  const [stage, setStage] = useState<Stage>({ name: 'idle' });
  const [dragging, setDragging] = useState(false);
  const session = useRef<ImportSession | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingOptions = useRef<Record<string, unknown>>({});
  const heading = useRef<HTMLHeadingElement>(null);

  const getSession = useCallback(() => {
    session.current ??= new ImportSession(app.db, app.userId);
    return session.current;
  }, [app.db, app.userId]);

  useEffect(
    () => () => {
      void session.current?.dispose();
      session.current = null;
    },
    [],
  );

  useEffect(() => onStageChange?.(stage.name === 'idle'), [stage.name, onStageChange]);

  // Each step replaces the content of the card: move focus to its heading so keyboard and
  // screen-reader users land on the new step instead of a button that no longer exists.
  useEffect(() => {
    if (stage.name !== 'idle' && stage.name !== 'detecting') heading.current?.focus();
  }, [stage.name]);

  const fail = useCallback((error: unknown) => {
    if (error instanceof ImportError && error.code === 'cancelled') {
      setStage({ name: 'idle' });
      return;
    }
    if (error instanceof ImportError) setStage({ name: 'error', message: error.message, code: error.code, details: error.details });
    else setStage({ name: 'error', message: error instanceof Error ? error.message : String(error), code: 'unexpected' });
  }, []);

  const run = useCallback(
    async (files: ImportFile[], detected: Detected, options: Record<string, unknown>) => {
      setStage({ name: 'parsing', detected, progress: null });
      try {
        const prepared = await getSession().prepare(files, detected, options, (progress) =>
          setStage((current) => (current.name === 'parsing' ? { ...current, progress } : current)),
        );
        setStage({ name: 'preview', prepared });
      } catch (error) {
        fail(error);
      }
    },
    [getSession, fail],
  );

  const start = useCallback(
    async (files: ImportFile[], options: Record<string, unknown> = {}) => {
      if (files.length === 0) {
        setStage({ name: 'error', message: 'Nothing readable was selected. If you chose a folder, it contains no files this app can import.', code: 'no_files' });
        return;
      }
      pendingOptions.current = options;
      setStage({ name: 'detecting', what: describeSelection(files) });
      try {
        const detected = await getSession().detect(files);
        // A file of the user's own making is read only after they have said what it cannot say itself.
        const question = questionBeforeReading(detected.parser, options);
        if (question === 'mapping') setStage({ name: 'mapping', files, detected });
        else if (question === 'confidence') setStage({ name: 'confidence', files, detected });
        else await run(files, detected, options);
      } catch (error) {
        fail(error);
      }
    },
    [getSession, run, fail],
  );

  const busy = stage.name !== 'idle' && stage.name !== 'done' && stage.name !== 'error';

  useImperativeHandle(
    ref,
    () => ({
      start: (files, options) => void start(files, options),
      chooseFiles: (accept) => {
        if (!fileInput.current) return;
        fileInput.current.accept = accept ?? '';
        fileInput.current.click();
      },
      busy,
    }),
    [start, busy],
  );

  const reset = async () => {
    await session.current?.discard();
    setStage({ name: 'idle' });
  };

  const save = async (prepared: PreparedImport) => {
    setStage({ name: 'saving', prepared });
    try {
      const result = await getSession().commit(prepared);
      app.notifyDataChanged();
      setStage({ name: 'done', prepared, result });
    } catch (error) {
      fail(error);
    }
  };

  const hiddenInput = (
    <input
      ref={fileInput}
      type="file"
      multiple
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(e) => {
        const files = toImportFiles(Array.from(e.target.files ?? []));
        e.target.value = '';
        if (files.length > 0) void start(files);
      }}
    />
  );

  if (stage.name === 'idle') {
    return (
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void filesFromDrop(e.dataTransfer).then((files) => start(files), fail);
        }}
        className={cn(
          'flex flex-col items-center gap-3 rounded-[var(--radius-card)] border border-dashed px-6 py-9 text-center transition-colors',
          dragging ? 'border-accent bg-accent-wash' : 'border-line-strong bg-surface',
        )}
      >
        {hiddenInput}
        <FileUp className="size-6 text-ink-3" aria-hidden="true" />
        <div>
          <p className="text-[15px] font-medium text-ink">Drop a file or folder here</p>
          <p className="mx-auto mt-1 max-w-[56ch] text-[13px] text-ink-2">
            The format is recognised from the contents. You see what would be added, and what is missing, before anything is saved. Files are read on
            this device and are not uploaded.
          </p>
        </div>
        <Button variant="primary" onClick={() => fileInput.current?.click()}>
          Choose files
        </Button>
      </div>
    );
  }

  const title =
    stage.name === 'detecting'
      ? 'Checking the file'
      : stage.name === 'mapping'
        ? 'Match the columns'
        : stage.name === 'confidence'
          ? 'Say how reliable the counts are'
          : stage.name === 'parsing'
            ? 'Reading'
            : stage.name === 'preview'
              ? 'Review before saving'
              : stage.name === 'saving'
                ? 'Saving'
                : stage.name === 'done'
                  ? 'Saved'
                  : 'This import did not work';

  return (
    <Card aria-live="polite">
      {hiddenInput}
      <CardHeader
        title={
          // Focus lands here when the step changes; the ring would suggest an interactive element.
          <span ref={heading} tabIndex={-1} style={{ outline: 'none' }}>
            {title}
          </span>
        }
      />
      <CardBody>
        {stage.name === 'detecting' ? (
          <div className="space-y-3">
            <p className="text-ink-2">Looking at {stage.what} to work out what it is.</p>
            <Progress value={null} label="Checking the file" />
          </div>
        ) : null}

        {stage.name === 'mapping' && stage.detected.csv ? (
          <CsvMappingForm
            fileName={stage.files[stage.detected.fileIndexes[0]]?.name ?? 'The file'}
            csv={stage.detected.csv}
            onCancel={reset}
            onSubmit={(options) => void run(stage.files, stage.detected, { ...pendingOptions.current, ...options })}
          />
        ) : null}

        {stage.name === 'confidence' ? (
          <ConfidenceForm
            fileName={stage.files[stage.detected.fileIndexes[0]]?.name ?? 'The file'}
            fileCount={stage.detected.fileIndexes.length}
            onCancel={reset}
            onSubmit={(answer) => void run(stage.files, stage.detected, { ...pendingOptions.current, ...answer })}
          />
        ) : null}

        {stage.name === 'parsing' ? (
          <div className="space-y-3">
            <p className="text-ink-2">
              Recognised as {FORMATS[stage.detected.parser].label}: {stage.detected.recognisedAs}.
              {stage.detected.ignoredFiles > 0 ? ` ${plural(stage.detected.ignoredFiles, 'other file')} in the selection will be ignored.` : ''}
            </p>
            <Progress
              value={stage.progress && stage.progress.totalBytes > 0 ? (stage.progress.bytesRead / stage.progress.totalBytes) * 100 : null}
              label="Reading the file"
            />
            <p className="tabular text-[13px] text-ink-2">
              {stage.progress
                ? `${stage.progress.phase}: ${formatBytes(stage.progress.bytesRead)} of ${formatBytes(stage.progress.totalBytes)}, ${formatInt(stage.progress.records)} records so far`
                : `Starting to read ${formatBytes(stage.detected.totalBytes)}`}
            </p>
            <div className="flex justify-end">
              <Button
                onClick={() => {
                  session.current?.cancel();
                }}
              >
                Cancel import
              </Button>
            </div>
          </div>
        ) : null}

        {stage.name === 'preview' || stage.name === 'saving' ? (
          <>
            <ImportPreviewView prepared={stage.prepared} timezone={app.settings.timezone} />
            <div className="mt-6 flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
              <p className="mr-auto text-[13px] text-ink-2">
                {stage.prepared.preview.nothingNew ? 'There is nothing to save.' : 'Nothing has been saved yet.'}
              </p>
              {stage.prepared.preview.nothingNew ? (
                // Nothing to add. For synced folders the commit still records which files were read, so the next sync can skip them.
                <Button
                  variant="primary"
                  loading={stage.name === 'saving'}
                  onClick={() => (stage.prepared.parsed.syncedFiles?.length ? void save(stage.prepared) : void reset())}
                >
                  Close
                </Button>
              ) : (
                <>
                  <Button variant="ghost" onClick={reset} disabled={stage.name === 'saving'}>
                    Cancel import
                  </Button>
                  <Button variant="primary" loading={stage.name === 'saving'} onClick={() => void save(stage.prepared)}>
                    Save to my history
                  </Button>
                </>
              )}
            </div>
          </>
        ) : null}

        {stage.name === 'done' ? <DoneView stage={stage} onAgain={() => setStage({ name: 'idle' })} /> : null}

        {stage.name === 'error' ? (
          <div className="space-y-4">
            <ErrorNote title={stage.message}>
              {NEXT_STEP[stage.code] ? <p>{NEXT_STEP[stage.code]}</p> : null}
              {stage.details ? <p className="mt-1 break-words text-xs text-ink-3">Detail: {stage.details}</p> : null}
            </ErrorNote>
            <p className="text-[13px] text-ink-2">Nothing was saved, and nothing that was already stored has changed.</p>
            <div className="flex justify-end">
              <Button variant="primary" onClick={reset}>
                Choose another file
              </Button>
            </div>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
});

function DoneView({ stage, onAgain }: { stage: Extract<Stage, { name: 'done' }>; onAgain: () => void }) {
  const { result, prepared } = stage;
  const added = result.inserted;
  const tokens = prepared.preview.tokens;
  const parts = [
    added.conversations > 0 ? plural(added.conversations, 'conversation') : null,
    added.messages > 0 ? plural(added.messages, 'message') : null,
    added.usageRows > 0 ? plural(added.usageRows, 'usage row') : null,
    added.costRows > 0 ? plural(added.costRows, 'cost row') : null,
  ].filter((v): v is string => v !== null);
  const duplicates = result.duplicates.messages + result.duplicates.usageRows + result.duplicates.costRows;
  return (
    <div className="space-y-4">
      <p className="flex items-start gap-2.5 text-ink">
        <CircleCheck className="mt-0.5 size-5 shrink-0 text-good" aria-hidden="true" />
        <span>
          {result.nothingNew
            ? 'The file held nothing new, so no records were added.'
            : `Added ${new Intl.ListFormat('en', { type: 'conjunction' }).format(parts)} from ${prepared.preview.fileName}.`}
        </span>
      </p>
      {!result.nothingNew && tokens.exact + tokens.estimated > 0 ? (
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
          Every chart now includes these tokens.
          {tokens.exact > 0 ? <ConfidenceBadge level="exact" /> : null}
          {tokens.estimated > 0 ? <ConfidenceBadge level="estimated" /> : null}
        </p>
      ) : null}
      {duplicates > 0 ? <p className="text-[13px] text-ink-2">{plural(duplicates, 'record')} already stored were skipped, so nothing is counted twice.</p> : null}
      {result.replaced.usageRows + result.replaced.costRows > 0 ? (
        <p className="text-[13px] text-ink-2">{plural(result.replaced.usageRows + result.replaced.costRows, 'earlier row')} for the same period were replaced.</p>
      ) : null}
      {result.removedDemoData ? <Notice>The synthetic demo data was removed. Everything you see from now on is your own.</Notice> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onAgain}>Import another file</Button>
        <Link href="/" className={buttonClass('primary')}>
          Open the overview
        </Link>
      </div>
    </div>
  );
}

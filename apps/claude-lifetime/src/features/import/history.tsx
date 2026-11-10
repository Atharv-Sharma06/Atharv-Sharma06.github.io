'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useState } from 'react';
import type { ImportRecord } from '@/analytics/coverage';
import { SOURCE_KIND_LABEL } from '@/components/shell/coverage-indicator';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm';
import { EmptyState, ErrorNote, Skeleton } from '@/components/ui/feedback';
import { Table, TableFrame, Td, Th, THead, Tr } from '@/components/ui/table';
import { deleteBatch } from '@/import/delete';
import { formatBytes, formatInstant, formatInt, plural } from '@/lib/format';
import { useApp } from '@/state/app';
import { useImports } from '@/state/queries';
import { stopAutoSyncAfterDeletion } from './local-files';

/**
 * Every import that was saved, with what it added, and a way to take each one back.
 * `autoSync` says whether the remembered Claude Code folder is read automatically:
 * deleting a Claude Code import switches that off, and the dialog says so beforehand.
 * While `locked` (an import is being prepared or previewed on this page) nothing can be
 * deleted: the preview was computed against what is stored now.
 */
export function ImportHistory({ autoSync = false, locked = false, onDeleted }: { autoSync?: boolean; locked?: boolean; onDeleted?: () => void }) {
  const app = useApp();
  const imports = useImports();
  const [open, setOpen] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<ImportRecord | null>(null);
  const tz = app.settings.timezone;
  const replacedEarlier = deleting?.warnings.find((w) => w.code === 'replaced_earlier') ?? null;

  return (
    <Card>
      <CardHeader
        title="Import history"
        description="Each import can be deleted on its own. Deleting one removes exactly the records it added and nothing else."
      />
      <CardBody>
        {imports.error ? (
          <ErrorNote title="The import history could not be read">{imports.error.message}</ErrorNote>
        ) : !imports.data ? (
          <Skeleton className="h-24" />
        ) : imports.data.length === 0 ? (
          <EmptyState title="No imports yet">Files you import appear here, with what each one added.</EmptyState>
        ) : (
          <TableFrame>
            <Table className="min-w-[46rem]">
              <THead>
                <tr>
                  <Th className="w-8">
                    <span className="sr-only">Details</span>
                  </Th>
                  <Th>File</Th>
                  <Th>Source</Th>
                  <Th>Imported</Th>
                  <Th>Covers</Th>
                  <Th align="right">Added</Th>
                  <Th align="right">Duplicates</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </THead>
              <tbody>
                {imports.data.map((r) => {
                  const expanded = open === r.batchId;
                  const notes = r.warnings.length + (r.missingFields.length > 0 ? 1 : 0);
                  return (
                    <Fragment key={r.batchId}>
                      <Tr className="align-top">
                        <Td className="pr-0">
                          <button
                            type="button"
                            onClick={() => setOpen(expanded ? null : r.batchId)}
                            aria-expanded={expanded}
                            aria-label={expanded ? `Hide details of ${r.fileName}` : `Show details of ${r.fileName}`}
                            className="rounded p-1 text-ink-3 hover:bg-raised hover:text-ink"
                          >
                            {expanded ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
                          </button>
                        </Td>
                        <Td className="max-w-[18rem]">
                          <span className="block truncate" title={r.fileName}>
                            {r.fileName}
                          </span>
                          <span className="block text-xs text-ink-3">
                            {r.fileSize > 0 ? `${formatBytes(r.fileSize)}, ` : ''}
                            {notes > 0 ? plural(notes, 'note') : 'no notes'}
                            {r.isSynthetic ? ', synthetic' : ''}
                          </span>
                        </Td>
                        <Td>
                          {r.sourceLabel}
                          <span className="block text-xs text-ink-3">{SOURCE_KIND_LABEL[r.sourceKind] ?? r.sourceKind}</span>
                        </Td>
                        <Td className="whitespace-nowrap text-ink-2">{formatInstant(r.importedAt, tz, 'datetime')}</Td>
                        <Td className="whitespace-nowrap text-ink-2">
                          {r.coverageStart ? `${formatInstant(r.coverageStart, tz)} – ${formatInstant(r.coverageEnd, tz)}` : '–'}
                        </Td>
                        <Td numeric>{formatInt(r.recordsInserted)}</Td>
                        <Td numeric className="text-ink-2">
                          {formatInt(r.recordsDuplicate)}
                        </Td>
                        <Td align="right">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={locked}
                            title={locked ? 'Save or cancel the import above first' : undefined}
                            onClick={() => setDeleting(r)}
                          >
                            Delete
                          </Button>
                        </Td>
                      </Tr>
                      {expanded ? (
                        <Tr className="border-t-0">
                          <Td />
                          <Td colSpan={7} className="pb-4 pt-0 text-ink-2">
                            <p>
                              {formatInt(r.recordsSeen)} records read, {formatInt(r.recordsInserted)} added, {formatInt(r.recordsDuplicate)} already stored,{' '}
                              {formatInt(r.recordsSkipped)} skipped. Format: {r.format}.
                            </p>
                            {r.missingFields.length > 0 ? <p className="mt-1">Not part of this format: {r.missingFields.join(', ')}.</p> : null}
                            {r.warnings.length > 0 ? (
                              <ul className="mt-2 space-y-1">
                                {r.warnings.map((w) => (
                                  <li key={w.code}>
                                    <span className="tabular text-ink">{formatInt(w.count)}</span> {w.message}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </Td>
                        </Tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
          </TableFrame>
        )}
      </CardBody>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => !next && setDeleting(null)}
        title="Delete this import?"
        confirmLabel="Delete import"
        onConfirm={async () => {
          if (!deleting) return;
          await deleteBatch(app.db, app.userId, deleting.batchId);
          // Otherwise the next visit would read the folder and put the deleted usage straight back.
          if (deleting.sourceKind === 'claude_code' && !deleting.isSynthetic) await stopAutoSyncAfterDeletion();
          app.notifyDataChanged();
          onDeleted?.();
        }}
      >
        <p>
          <span className="text-ink">{deleting?.fileName}</span>, imported on {deleting ? formatInstant(deleting.importedAt, tz, 'datetime') : ''}.
        </p>
        <p>
          The {deleting ? formatInt(deleting.recordsInserted) : ''} records it added are removed, along with conversations that have nothing left in them.
          Records from other imports stay. You can import the file again at any time.
        </p>
        {replacedEarlier ? (
          <p>
            This import replaced {plural(replacedEarlier.count, 'record')} that an earlier import had stored for the same period. Deleting it does not
            bring them back: that period will be empty until the earlier file is imported again.
          </p>
        ) : null}
        {deleting?.sourceKind === 'claude_code' && !deleting.isSynthetic && autoSync ? (
          <p>
            Reading the Claude Code folder automatically is switched off with this, because it would add the deleted usage again the next time the app
            opens. You can switch it back on above.
          </p>
        ) : null}
      </ConfirmDialog>
    </Card>
  );
}

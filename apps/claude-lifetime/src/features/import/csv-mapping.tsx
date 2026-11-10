'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Segmented, Select } from '@/components/ui/controls';
import { InfoTip } from '@/components/ui/overlay';
import { Table, TableFrame, Td, Th, THead, Tr } from '@/components/ui/table';
import type { CsvPreview } from '@/import/generic/csv';
import { checkCsvMapping, GENERIC_FIELD_SPECS, GENERIC_FIELDS, type GenericField } from '@/import/generic/fields';
import { Notice } from './preview';

const NONE = '__none__';

export interface CsvImportOptions {
  mapping: Partial<Record<GenericField, string>>;
  confidence: 'exact' | 'estimated';
  sourceLabel: string;
  sourceRef: string;
  delimiter: string;
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

// ── What was chosen the last time ───────────────────────────────────────────────
//
// Rows of a table are recognised as already stored only within one source, and only
// when the same columns were read as the same fields. So the choices made for a table
// are remembered on this device by the names of its columns: importing the same file
// again, or a newer export of it, starts with the same source name, column meanings and
// reliability, and adds only what is new. The user can still change any of them.

interface Remembered {
  label: string;
  confidence: 'exact' | 'estimated';
  mapping: Partial<Record<GenericField, string>>;
}

function memoryKey(header: string[]): string {
  // FNV-1a over the column names: short, and the same for the same columns in the same order.
  let hash = 0x811c9dc5;
  for (const char of header.join('\u001f').toLowerCase()) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `claude-lifetime:csv-columns:${hash.toString(16)}`;
}

function recall(header: string[]): Remembered | null {
  try {
    const raw = window.localStorage.getItem(memoryKey(header));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Remembered>;
    const mapping: Partial<Record<GenericField, string>> = {};
    for (const field of GENERIC_FIELDS) {
      const column = value.mapping?.[field];
      if (typeof column === 'string' && header.includes(column)) mapping[field] = column;
    }
    return {
      label: typeof value.label === 'string' ? value.label.slice(0, 80) : '',
      confidence: value.confidence === 'exact' ? 'exact' : 'estimated',
      mapping,
    };
  } catch {
    // no storage, or something else was stored there: start from the proposal
    return null;
  }
}

function remember(header: string[], choice: Remembered): void {
  try {
    window.localStorage.setItem(memoryKey(header), JSON.stringify(choice));
  } catch {
    // not remembered; the import itself is not affected
  }
}

/**
 * The mapping step for a CSV of the user's own making: which column holds which
 * field. The proposal comes from the header names; nothing is imported until the
 * mapping is valid and the user continues.
 */
export function CsvMappingForm({
  fileName,
  csv,
  onSubmit,
  onCancel,
}: {
  fileName: string;
  csv: CsvPreview;
  onSubmit: (options: CsvImportOptions) => void;
  onCancel: () => void;
}) {
  // Read once, when the form appears for this file.
  const [before] = useState(() => recall(csv.header));
  const [chosen, setChosen] = useState<Partial<Record<GenericField, string>>>(before && Object.keys(before.mapping).length > 0 ? before.mapping : csv.detected.mapping);
  const [confidence, setConfidence] = useState<'exact' | 'estimated'>(before?.confidence ?? 'estimated');
  const [label, setLabel] = useState(before?.label ?? '');

  const check = useMemo(() => checkCsvMapping(csv.header, chosen), [csv.header, chosen]);
  const columns = useMemo(
    () => [{ value: NONE, label: 'Not in this file' }, ...csv.header.filter((h) => h !== '').map((h) => ({ value: h, label: h }))],
    [csv.header],
  );
  const example = (column: string | undefined) => {
    if (!column) return '';
    const index = csv.header.indexOf(column);
    if (index === -1) return '';
    return csv.sampleRows.map((r) => r[index] ?? '').find((v) => v.trim() !== '') ?? '';
  };

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (check.problems.length > 0) return;
        const sourceLabel = label.trim() || 'Custom usage data';
        remember(csv.header, { label: label.trim(), confidence, mapping: check.mapping });
        onSubmit({ mapping: check.mapping, confidence, sourceLabel, sourceRef: label.trim() ? slug(label) : '', delimiter: csv.delimiter });
      }}
    >
      <div>
        <p className="text-ink">
          <span className="font-medium">{fileName}</span> is a table with {csv.header.length} columns.
        </p>
        <p className="mt-0.5 text-[13px] text-ink-2">
          Say which column holds what. A date or time and at least one token count are needed; everything else is optional. Columns you leave out are
          ignored.
        </p>
        {before ? (
          <p className="mt-1.5 text-[13px] text-ink-2">
            A table with these columns was imported on this device before. The choices made then are filled in, so that rows which are already stored
            are recognised and not counted again.
          </p>
        ) : null}
      </div>

      <TableFrame>
        <Table className="min-w-[38rem]">
          <THead>
            <tr>
              <Th>Field</Th>
              <Th>Column in your file</Th>
              <Th>First value</Th>
            </tr>
          </THead>
          <tbody>
            {GENERIC_FIELDS.map((field) => {
              const spec = GENERIC_FIELD_SPECS[field];
              return (
                <Tr key={field}>
                  <Td className="whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      {spec.label}
                      {field === 'timestamp' ? <span className="text-xs text-ink-3">required</span> : null}
                      <InfoTip label={`About ${spec.label}`} align="start">
                        <p>{spec.hint}</p>
                      </InfoTip>
                    </span>
                  </Td>
                  <Td>
                    <Select
                      label={`Column for ${spec.label}`}
                      value={chosen[field] ?? NONE}
                      onChange={(value) => setChosen((prev) => ({ ...prev, [field]: value === NONE ? undefined : value }))}
                      options={columns}
                      className="h-8 w-full max-w-[16rem]"
                    />
                  </Td>
                  <Td className="max-w-[14rem] truncate text-ink-2" title={example(chosen[field])}>
                    {example(chosen[field]) || '–'}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </TableFrame>

      {check.problems.length > 0 ? (
        <div className="space-y-2" role="alert">
          {check.problems.map((problem) => (
            <Notice key={problem.code + problem.message} tone="warning">
              {problem.message}
            </Notice>
          ))}
        </div>
      ) : check.unmappedColumns.length > 0 ? (
        <p className="text-[13px] text-ink-2">
          Not used: {check.unmappedColumns.slice(0, 10).join(', ')}
          {check.unmappedColumns.length > 10 ? `, and ${check.unmappedColumns.length - 10} more` : ''}.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] text-ink-2">How reliable are these token counts?</span>
          <Segmented
            label="Confidence of the token counts"
            value={confidence}
            onChange={setConfidence}
            options={[
              { value: 'estimated', label: 'Estimated' },
              { value: 'exact', label: 'Exact' },
            ]}
            className="self-start"
          />
          <span className="text-xs text-ink-3">
            Choose Exact only for counts metered by the API or a tool that reads them from it. Everything else is an estimate and is labelled as one.
          </span>
        </div>
        <Field
          label="Name of this source"
          hint="Shown next to the figures, and keeps different tables apart. Optional. Use the same name whenever you import a newer version of the same table: rows are only recognised as already stored under the same name."
        >
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Custom usage data" maxLength={80} />
        </Field>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel import
        </Button>
        <Button type="submit" variant="primary" disabled={check.problems.length > 0}>
          Read the file
        </Button>
      </div>
    </form>
  );
}

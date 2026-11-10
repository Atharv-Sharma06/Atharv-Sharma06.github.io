import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConfidenceChoice, ConfidenceForm, CsvMappingForm } from '@/features/import/csv-mapping';
import { detectCsvMapping } from '@/import/generic/fields';

/**
 * The step a JSON usage file gets before it is read. The file format has no field
 * that says whether its counts were metered, so the person is asked, exactly as for
 * a CSV table. Without the step every JSON usage file was stored as an estimate.
 */
const noop = () => undefined;

const QUESTION = 'How reliable are these token counts?';
const ADVICE = 'Choose Exact only for counts metered by the API or a tool that reads them from it. Everything else is an estimate and is labelled as one.';

const jsonStep = (props: { fileName?: string; fileCount?: number } = {}) =>
  renderToStaticMarkup(createElement(ConfidenceForm, { fileName: 'usage.json', fileCount: 1, onSubmit: noop, onCancel: noop, ...props }));

const csvStep = () => {
  const header = ['timestamp', 'model', 'input_tokens', 'output_tokens'];
  const csv = { header, delimiter: ',', sampleRows: [['2026-03-01', 'claude-sonnet-4-6', '10', '5']], detected: detectCsvMapping(header) };
  return renderToStaticMarkup(createElement(CsvMappingForm, { fileName: 'usage.csv', csv, onSubmit: noop, onCancel: noop }));
};

/** The options of the choice as the browser gets them: what each says, and whether it is the chosen one. */
const options = (html: string) => [...html.matchAll(/<button[^>]*role="radio" aria-checked="(true|false)"[^>]*>([^<]+)<\/button>/g)].map((m) => [m[2], m[1] === 'true']);

describe('the step that asks how reliable the counts of a JSON usage file are', () => {
  it('asks the question of the CSV step, in the same words and with the same control', () => {
    const asked = renderToStaticMarkup(createElement(ConfidenceChoice, { value: 'estimated', onChange: noop }));
    expect(asked).toContain(QUESTION);
    expect(asked).toContain(ADVICE);
    expect(jsonStep()).toContain(asked);
    expect(csvStep()).toContain(asked);
  });

  it('starts with Estimated, so that nothing is declared exact without the person saying so', () => {
    expect(options(jsonStep())).toEqual([
      ['Estimated', true],
      ['Exact', false],
    ]);
  });

  it('can be used with the keyboard and by a screen reader', () => {
    const html = jsonStep();
    // one named group of radio buttons
    expect(html).toMatch(/<div[^>]*role="radiogroup" aria-label="Confidence of the token counts"/);
    // inside a form, so that Enter reads the file; cancelling does not submit it
    expect(html).toMatch(/^<form/);
    expect(html).toMatch(/<button type="submit"[^>]*>Read the file<\/button>/);
    expect(html).toMatch(/<button type="button"[^>]*>Cancel import<\/button>/);
  });

  it('names what is about to be read', () => {
    expect(jsonStep({ fileName: 'proxy-march.json' })).toContain('proxy-march.json');
    const several = jsonStep({ fileName: 'a.json', fileCount: 3 });
    expect(several).toContain('3 files');
    expect(several).toMatch(/<button type="submit"[^>]*>Read the files<\/button>/);
  });
});

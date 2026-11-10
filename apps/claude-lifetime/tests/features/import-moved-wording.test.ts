import { describe, expect, it } from 'vitest';
import { ImportError } from '@/core/types';
import { DatabaseMovedError } from '@/db/driver';
import { failureStage, MOVED_MESSAGE, NEXT_STEP } from '@/features/import/wizard';

/**
 * What the import card says when the tab that held the database went away in the middle
 * of an import. The driver's own sentence is written for a change of any kind; under it
 * the card used to add "Nothing was saved, and nothing that was already stored has
 * changed", so the person was told to check whether it was saved and, in the next line,
 * that nothing was.
 */
describe('an import during which the database moves to another tab', () => {
  it('says while reading that nothing is stored and that the file has to be read again', () => {
    const stage = failureStage(new DatabaseMovedError(), 'reading');
    expect(stage.message).toBe(MOVED_MESSAGE.reading);
    expect(stage.message).toBe('The tab that held the database was closed or reloaded while this file was being read, and another tab has taken over.');
    expect(NEXT_STEP[stage.code]).toBe('Choose the file again: reading it has to start over.');
    // Nothing is stored before an import is saved, so the card's line "Nothing was saved…" is true here and stays.
    expect(stage.unknownOutcome).toBeUndefined();
    expect(stage.message).not.toContain('whether your change was stored');
  });

  it('says while saving that it is not known whether the import was stored, and what to do about that', () => {
    const stage = failureStage(new DatabaseMovedError(), 'saving');
    expect(stage.message).toBe('The tab that held the database was closed or reloaded while this import was being saved, and another tab has taken over.');
    expect(NEXT_STEP[stage.code]).toBe(
      'It is not known whether the import was stored. Look for it in the list of imports below. If it is not there, import the file again: what is already stored is recognised and not counted twice.',
    );
    // The line "Nothing was saved…" is left out: it is not known to be true.
    expect(stage.unknownOutcome).toBe(true);
  });

  it('leaves every other failure as it was', () => {
    expect(failureStage(new ImportError('The archive does not contain a conversations.json file.', 'no_conversations_file'), 'reading')).toEqual({
      name: 'error',
      message: 'The archive does not contain a conversations.json file.',
      code: 'no_conversations_file',
      details: undefined,
    });
    expect(failureStage(new Error('out of memory'), 'saving')).toEqual({ name: 'error', message: 'out of memory', code: 'unexpected' });
    expect(failureStage('boom', 'reading')).toEqual({ name: 'error', message: 'boom', code: 'unexpected' });
  });
});

describe('what stands above a change that may have been stored all the same', () => {
  it('is told apart by the message of a database that moved, and by nothing else', async () => {
    const { outcomeUnknown } = await import('@/db/driver');
    expect(outcomeUnknown(new DatabaseMovedError().message)).toBe(true);
    expect(outcomeUnknown('Enter a day that is not in the future.')).toBe(false);
    expect(outcomeUnknown(null)).toBe(false);
  });

  it('says "may not have been saved" in a settings row, where it said "could not be saved" before', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { SaveError } = await import('@/features/settings/parts');
    const row = (message: string) => renderToStaticMarkup(createElement(SaveError, { state: { status: 'error', message } }));

    const moved = row(new DatabaseMovedError().message);
    // Before the fix: "This could not be saved. … It is not known whether your change was stored".
    expect(moved).toContain('This may not have been saved. The tab that held the database was closed or reloaded at that moment');
    expect(moved).not.toContain('could not be saved');
    expect(row('The quota has been exceeded.')).toContain('This could not be saved. The quota has been exceeded.');
  });
});

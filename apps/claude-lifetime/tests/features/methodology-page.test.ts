import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MethodologyPage } from '@/features/methodology/methodology-page';

/**
 * "How it is counted" makes claims about the app that a reader takes at their word: where
 * a control is, how far off an estimate can be, and what the app keeps. Each must hold
 * for every reader, on every screen width and for every kind of import.
 */
const page = renderToStaticMarkup(createElement(MethodologyPage))
  .replaceAll('&#x27;', "'")
  .replaceAll('’', "'")
  // The text of a paragraph, without the line breaks of the source.
  .replace(/\s+/g, ' ');

const section = (id: string) => page.match(new RegExp(`<section id="${id}"[^>]*>(.*?)</section>`))?.[1] ?? '';
const text = (html: string) => html.replace(/<[^>]+>/g, '');

describe('How it is counted', () => {
  it('names every place the switch between processed and new tokens is, not only the top bar', () => {
    // Below 768 px the top bar has no switch; there it is in the menu. Settings has it at any width.
    const tokens = text(section('tokens'));
    expect(tokens).not.toContain('The switch in the top bar chooses one.');
    expect(tokens).toContain('The Processed and New switch chooses one. It is in the top bar, or in the menu on a narrow screen, and under Token basis in Settings.');
  });

  it('quotes the known weak cases of the estimator in full, not only the 14% ones', () => {
    const chat = text(section('chat'));
    expect(chat).not.toContain('the weakest cases are Korean prose');
    for (const known of [
      'everyday Korean prose up to about 12% low',
      'Chinese legal prose about 10% low',
      'Russian technical text about 6% high',
      'languages it was not fitted on such as Dutch and Indonesian about 14% low',
      'Vietnamese stored in decomposed Unicode form about 27% high',
      'up to about 28% off either way',
    ]) {
      expect(chat).toContain(known);
    }
  });

  it('names the figures in TOKEN-ESTIMATION.md, so the two cannot drift apart unnoticed', () => {
    const doc = readFileSync(fileURLToPath(new URL('../../docs/TOKEN-ESTIMATION.md', import.meta.url)), 'utf8').replace(/\s+/g, ' ');
    expect(doc).toContain(
      'Known weak spots: everyday Korean prose (-6% to -12%), Chinese legal prose (-10%), Russian technical text (+6%), languages the model was not fitted on (Dutch and Indonesian about -14%, Urdu -8%), Vietnamese in decomposed Unicode form (+27%), and single documents of unusual material such as long base64 blobs or hex test vectors (up to ±28%).',
    );
    expect(doc).toContain('It is in the top bar, or in the menu on a screen narrower than 768 pixels, and under Token basis in Settings.');
    expect(doc).not.toContain('the switch in the top bar chooses');
  });

  it('says that Claude Code imports also keep the project folder, the git branch and the version', () => {
    // src/import/claude-code/aggregate.ts stores the working directory as the project
    // label and the git branch, the version and whether subagents ran in the metadata.
    const privacy = text(section('privacy'));
    expect(privacy).toContain(
      'For each Claude Code session it also stores the path of the project folder it ran in, its git branch, the version of Claude Code and whether it used subagents.',
    );
  });
});

describe('README', () => {
  const readme = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8').replace(/\s+/g, ' ');

  it('lists what Claude Code imports add to the stored metadata', () => {
    expect(readme).toContain(
      'For each Claude Code session it also stores the path of the project folder it ran in, its git branch, the version of Claude Code and whether it used subagents.',
    );
  });

  it('says what npm run db:migration needs', () => {
    expect(readme).toContain('Needs a running PostgreSQL server and `SHADOW_DATABASE_URL`');
    expect(readme).toContain('`SHADOW_DATABASE_URL` is required by `npm run db:migration`.');
  });
});

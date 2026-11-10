import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BootError, BootProgress } from '@/components/shell/boot';
import { DatabaseBusyError, SETUP_TIMEOUT_MS } from '@/db/client';
import { DatabaseMovedError, DatabaseUnavailableError } from '@/db/driver';
import { MigrationError, NewerSchemaError } from '@/db/migrate';

/**
 * The start-up error screen. A page of an older version that meets data a newer
 * version has upgraded cannot be helped by trying again: the person has to reload to
 * get the newer page, and is told exactly that.
 */
const html = (error: Error, retry: () => void = () => undefined) =>
  renderToStaticMarkup(createElement(BootError, { error, retry }))
    // React escapes apostrophes; the assertions below read better without that.
    .replaceAll('&#x27;', "'");

type Props = { children?: ReactNode; onClick?: () => void };

/** Renders function components by hand, down to the elements the browser would get. BootError uses no hooks. */
function expand(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(expand);
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<Props>;
  if (typeof element.type === 'function') return expand((element.type as (props: Props) => ReactNode)(element.props));
  return { ...element, props: { ...element.props, children: expand(element.props.children) } };
}

/** The click handlers of every button on the screen, by what the button says. */
function buttons(node: ReactNode, found = new Map<string, () => void>()): Map<string, () => void> {
  if (Array.isArray(node)) {
    for (const child of node) buttons(child, found);
  } else if (isValidElement(node)) {
    const { children, onClick } = (node as ReactElement<Props>).props;
    if (onClick) found.set(text(children), onClick);
    buttons(children, found);
  }
  return found;
}
const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join('') : isValidElement(node) ? text((node as ReactElement<Props>).props.children) : typeof node === 'string' ? node : '';

afterEach(() => vi.unstubAllGlobals());

describe('BootError, for data that a newer version of the app has upgraded', () => {
  const newer = new NewerSchemaError(['20991231000000_from_a_later_release']);

  it('says what happened and what to do', () => {
    const screen = html(newer);
    expect(screen).toContain('This data was last opened by a newer version of the app. Reload the page to get that version.');
    // the migration it does not know, for whoever has to look into it
    expect(screen).toContain('20991231000000_from_a_later_release');
  });

  it('offers to reload, and not to try again with the same code', () => {
    const screen = html(newer, () => {
      throw new Error('trying again must not be offered');
    });
    expect(screen).toMatch(/<button[^>]*>Reload the page<\/button>/);
    expect(screen).not.toContain('Try again');
    // The advice for a database that cannot be opened does not apply: this one opened fine.
    expect(screen).not.toContain('could not be opened');
    expect(screen).not.toContain('incognito');
  });

  it('reloads the page when the button is pressed', () => {
    const reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });
    const retry = vi.fn();

    const found = buttons(expand(createElement(BootError, { error: newer, retry })));
    expect([...found.keys()]).toEqual(['Reload the page']);
    found.get('Reload the page')!();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });
});

describe('BootError, for every other start-up failure', () => {
  it('keeps the screen it had: the reason and a way to try again', () => {
    const retry = vi.fn();
    const error = new Error('Could not load /claude-lifetime/pglite/0.5.16/pglite.wasm.gz (HTTP 404)');
    const screen = html(error, retry);
    expect(screen).toContain('The local database could not be opened');
    expect(screen).toContain('Could not load /claude-lifetime/pglite/0.5.16/pglite.wasm.gz (HTTP 404)');
    expect(screen).not.toContain('newer version');

    const found = buttons(expand(createElement(BootError, { error, retry })));
    expect([...found.keys()]).toEqual(['Try again']);
    found.get('Try again')!();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('does not mistake a migration that failed for a newer version', () => {
    const screen = html(new MigrationError('Migration "20261110000100_x" failed and was rolled back: division by zero', '20261110000100_x'));
    expect(screen).toContain('The local database could not be opened');
    expect(screen).toContain('Try again');
    expect(screen).not.toContain('newer version');
  });
});

describe('BootError, for a database that is there but held by another tab', () => {
  it('says that the database did not answer and what to do about the other tabs, without the advice for a database that cannot be stored', () => {
    const retry = vi.fn();
    const busy = new DatabaseBusyError(SETUP_TIMEOUT_MS);
    const screen = html(busy, retry);
    expect(screen).toContain('The database did not answer');
    expect(screen).toContain('This tab waited for its turn and did not get one in time.');
    expect(screen).toContain('If another tab is in the middle of a large import or a backup, let it finish, then try again.');
    expect(screen).toContain('Otherwise reload the other open tabs of Claude Lifetime, or close them, then try again.');
    expect(screen).toContain('Nothing was changed, and your data is still stored in this browser.');
    // Before the fix this case never ended; the generic screen it would have reached speaks of
    // private windows, browser versions and disk space, none of which has anything to do with it.
    expect(screen).not.toContain('could not be opened');
    expect(screen).not.toContain('incognito');
    expect(screen).not.toContain('disk space');

    const found = buttons(expand(createElement(BootError, { error: busy, retry })));
    expect([...found.keys()]).toEqual(['Try again']);
    found.get('Try again')!();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('says so when the tab that held the database kept going away during the start', () => {
    const screen = html(new DatabaseMovedError());
    expect(screen).toContain('The database changed hands while this tab was starting');
    expect(screen).toContain('The tab that held it was closed or reloaded several times while this one was starting, so this tab stopped trying.');
    expect(screen).toContain('Try again');
    expect(screen).not.toContain('incognito');
    // The sentence for a change that may not have been saved is not for a start: nothing was being saved.
    expect(screen).not.toContain('whether your change was stored');
  });
});

describe('BootError, for a database that no tab could open after the tab that held it was closed', () => {
  it('says so, with the reason this tab’s own attempt gave, and offers to try again', () => {
    const screen = html(new DatabaseUnavailableError('Could not load /claude-lifetime/pglite/0.5.16/pglite.wasm.gz (TypeError: Failed to fetch)'));
    expect(screen).toContain('The database did not answer');
    expect(screen).toContain(
      'The tab that held it was closed while this one was starting, and no tab has been able to open it since (Could not load /claude-lifetime/pglite/0.5.16/pglite.wasm.gz (TypeError: Failed to fetch)).',
    );
    expect(screen).toContain('Try again');
    expect(screen).not.toContain('incognito');
    // The advice for a database that another tab keeps busy does not apply either.
    expect(screen).not.toContain('large import or a backup');
  });
});

describe('the start-up screen while it waits', () => {
  const progress = (phase: 'starting' | 'migrating' | 'ready', slow: boolean) => renderToStaticMarkup(createElement(BootProgress, { phase, slow }));

  it('only names the step at first', () => {
    expect(progress('migrating', false)).toContain('Preparing the database…');
    expect(progress('migrating', false)).not.toContain('Another tab');
    expect(progress('starting', false)).not.toContain('Another tab');
  });

  it('says what it is probably waiting for once a step takes long', () => {
    // A tab that opens while another one saves a large import waits for that, in either of the first two steps.
    expect(progress('migrating', true)).toContain(
      'This tab is waiting for its turn at the database, which the tabs of Claude Lifetime share. Another tab is probably in the middle of an import or a backup; this one goes on when that is done.',
    );
    expect(progress('starting', true)).toContain(
      'Either the database engine (about 5.5 MB) is still being downloaded, or another tab of Claude Lifetime is in the middle of an import or a backup',
    );
    expect(progress('ready', true)).not.toContain('Another tab');
  });
});

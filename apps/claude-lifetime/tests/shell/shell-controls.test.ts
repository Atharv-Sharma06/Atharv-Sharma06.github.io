import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two controls of the top bar that change what every figure counts: the date range
 * and the switch between processed and new tokens. The shell is rendered with the app's
 * state, the router and the parts of the top bar that read the database replaced by
 * stand-ins, so that only the shell's own decisions are under test.
 */
const address = vi.hoisted(() => ({ pathname: '/', search: '' }));
const saved = vi.hoisted(() => [] as unknown[]);

vi.mock('next/navigation', () => ({
  usePathname: () => address.pathname,
  useSearchParams: () => new URLSearchParams(address.search),
}));

vi.mock('@/state/app', () => {
  const app = {
    settings: { basis: 'new' },
    saveSettings: async (patch: unknown) => void saved.push(patch),
    range: { preset: 'all', from: null, to: null },
    resolved: { from: null, to: null },
    setRange: () => undefined,
  };
  return {
    RANGE_PRESETS: [
      { value: 'all', label: 'All time' },
      { value: '30d', label: 'Last 30 days' },
    ],
    useApp: () => app,
    useAppState: () => ({ status: 'ready', app }),
  };
});
vi.mock('@/state/queries', () => ({ useCoverage: () => ({ data: undefined }) }));
vi.mock('@/components/shell/refresh-status', () => ({ RefreshStatus: () => null }));
vi.mock('@/components/shell/coverage-indicator', () => ({ CoverageIndicator: () => null }));
vi.mock('@/import/delete', () => ({ deleteAllData: async () => undefined }));

const { AppShell, MenuPanel } = await import('@/components/shell/app-shell');
const { rangeUse } = await import('@/components/shell/date-range');
const { MenuBasisSwitch } = await import('@/components/shell/basis-switch');

const shellAt = (pathname: string, search = '') => {
  address.pathname = pathname;
  address.search = search;
  return renderToStaticMarkup(createElement(AppShell, null, 'page')).replaceAll('&#x27;', "'");
};
/** The accessible name of the date range control in the top bar. */
const rangeControl = (html: string) => html.match(/aria-label="(Date range: [^"]*)"/)?.[1];

beforeEach(() => void (saved.length = 0));

describe('the date range control', () => {
  it('can be used on the pages whose figures follow the range', () => {
    for (const path of ['/', '/usage/', '/conversations/', '/models/']) expect(rangeControl(shellAt(path)), path).toBe('Date range: All time');
    // the list of conversations keeps its filters in the query string and still follows the range
    expect(rangeControl(shellAt('/conversations/', 'q=refactor&page=2'))).toBe('Date range: All time');
  });

  it('says "Whole history" on the pages that ignore the range', () => {
    for (const path of ['/activity/', '/subscriptions/', '/settings/', '/import/', '/methodology/']) {
      const html = shellAt(path);
      expect(rangeControl(html), path).toBe('Date range: not used on this page');
      expect(html).toContain('Whole history');
    }
  });

  it('says "Whole history" on the page of one conversation, which is shown at the address of the list', () => {
    // The page of a conversation shows lifetime figures. Before the fix the control
    // looked at the pathname only, offered the range there, and changing it did nothing.
    const html = shellAt('/conversations/', 'id=1350&q=refactor');
    expect(rangeControl(html)).toBe('Date range: not used on this page');
    expect(html).toContain('Whole history');
  });

  it('explains on the conversation page why the range does not apply there', () => {
    const use = rangeUse('/conversations/', new URLSearchParams('id=7'));
    expect(use).toEqual({
      applies: false,
      note: "A conversation's page always covers the whole conversation. The date range applies to the list of conversations, Overview, Lifetime Usage and Model Breakdown.",
    });
    // other pages keep their explanation
    expect(rangeUse('/activity/', new URLSearchParams())).toEqual({
      applies: false,
      note: 'This page always covers your whole history. The date range applies to Overview, Lifetime Usage, Conversations and Model Breakdown.',
    });
    // an id on another page means nothing to the range
    expect(rangeUse('/usage/', new URLSearchParams('id=7'))).toEqual({ applies: true });
  });
});

describe('the switch between processed and new tokens', () => {
  /**
   * The options of a Token basis switch, with whether each is the chosen one. The switch
   * is a named group of radio buttons: a screen reader announces which one is chosen, and
   * the arrow keys move between them.
   */
  const options = (html: string) => {
    const group = html.match(/<div[^>]*role="radiogroup" aria-label="Token basis"[^>]*>(.*?)<\/div>/)?.[1] ?? '';
    return [...group.matchAll(/<button[^>]*aria-checked="(true|false)"[^>]*>([^<]+)<\/button>/g)].map((m) => [m[2], m[1] === 'true']);
  };

  it('is in the menu that narrow screens use, as the same named switch with its state', () => {
    // Below 768 px the top bar has no room for the switch, so the menu carries it. Before
    // the fix only Settings had it on a phone.
    const menu = renderToStaticMarkup(createElement(MenuPanel, { pathname: '/', ready: true, onNavigate: () => undefined }));
    expect(options(menu)).toEqual([
      ['Processed', false],
      ['New', true],
    ]);
    // shown only where the top bar has none, so that no width shows it twice
    expect(menu).toMatch(/<div class="shrink-0 md:hidden">.*aria-label="Token basis"/);
    // a touch screen has no hover, so the explanation is written out
    expect(menu).toContain(
      'Processed counts everything the model read and wrote, including context that is re-read on every turn. New counts each piece of content once.',
    );
  });

  it('is left out of the menu until the app is ready, since it needs the saved settings', () => {
    const menu = renderToStaticMarkup(createElement(MenuPanel, { pathname: '/', ready: false, onNavigate: () => undefined }));
    expect(menu).not.toContain('Token basis');
  });

  it('stays in the top bar on wider screens', () => {
    const html = shellAt('/');
    expect(html).toMatch(/<div class="hidden md:block">.*?aria-label="Token basis"/);
    expect(options(html)).toEqual([
      ['Processed', false],
      ['New', true],
    ]);
  });

  it('saves the basis that is chosen in the menu', async () => {
    // Radix renders each option as a radio button; the switch passes the choice on unchanged.
    const { Segmented } = await import('@/components/ui/controls');
    const element = MenuBasisSwitch();
    const found: Array<{ onChange: (v: string) => void }> = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      const el = node as { type: unknown; props: { children?: unknown; onChange?: (v: string) => void } };
      if (typeof el.type === 'function' && el.type !== Segmented) return walk((el.type as (p: unknown) => unknown)(el.props));
      if (el.type === Segmented && el.props.onChange) found.push({ onChange: el.props.onChange });
      walk(el.props?.children);
    };
    walk(element);
    expect(found).toHaveLength(1);
    found[0].onChange('processed');
    expect(saved).toEqual([{ basis: 'processed' }]);
  });
});

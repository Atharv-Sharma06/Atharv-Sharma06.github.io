import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Coverage } from '@/analytics/coverage';

/**
 * "See what is known and what is missing" brings the coverage panel into view on every
 * click, also when the address already ends in #coverage, and the panel brings itself
 * into view when it appears with #coverage in the address (the overview renders it only
 * after its figures are read, after the browser looked for the target). Smooth scrolling
 * is left out for people who prefer reduced motion.
 */

// Effects run at once when a component function is called, so that the panel's effect can be observed without a DOM.
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return { ...react, useEffect: (effect: () => void) => void effect() };
});
vi.mock('next/link', () => ({ default: (props: { href: string; children?: ReactNode }) => props }));

const coverage: Coverage = {
  hasData: true,
  hasSyntheticData: false,
  earliestRecordAt: null,
  latestRecordAt: null,
  earliestDay: '2025-01-01',
  latestDay: '2025-02-01',
  sources: [],
  importCount: 1,
  basis: 'processed',
  exactTokens: 10,
  estimatedTokens: 0,
  textEstimatedTokens: 0,
  statedEstimatedTokens: 0,
  tokensWithModel: 10,
  tokensWithoutModel: 0,
  gaps: [],
  gapCount: 0,
  gapDays: 14,
  limitations: [],
  estimatedMessages: 0,
};
vi.mock('@/state/queries', () => ({ useCoverage: () => ({ data: coverage }) }));

/** A page with the panel on it, or without it, in a browser that may prefer reduced motion. */
function installPage({ panel, hash = '', reducedMotion = false }: { panel: boolean; hash?: string; reducedMotion?: boolean }) {
  const scrollIntoView = vi.fn();
  const frames: Array<() => void> = [];
  vi.stubGlobal('document', { getElementById: (id: string) => (panel && id === 'coverage' ? { scrollIntoView } : null) });
  vi.stubGlobal('window', {
    location: { hash },
    matchMedia: (query: string) => ({ matches: reducedMotion && query === '(prefers-reduced-motion: reduce)' }),
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
  });
  return { scrollIntoView, runFrames: () => frames.splice(0).forEach((f) => f()) };
}

afterEach(() => vi.unstubAllGlobals());

/** The first element in a tree whose props match. */
function find(node: ReactNode, match: (props: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, match);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = (node as ReactElement<Record<string, unknown>>).props;
  if (match(props)) return props;
  return find(props.children as ReactNode, match) ?? find(props.trigger as ReactNode, match);
}

describe('the link to the coverage panel', () => {
  const link = async () => {
    const { CoverageIndicator } = await import('@/components/shell/coverage-indicator');
    const props = find(CoverageIndicator(), (p) => p.href === '/#coverage');
    expect(props).not.toBeNull();
    return props as { onClick: () => void };
  };

  it('scrolls to the panel on every click, also when the address already ends in #coverage', async () => {
    const page = installPage({ panel: true, hash: '#coverage' });
    const { onClick } = await link();
    onClick();
    page.runFrames();
    onClick();
    page.runFrames();
    expect(page.scrollIntoView).toHaveBeenCalledTimes(2);
    expect(page.scrollIntoView).toHaveBeenLastCalledWith({ behavior: 'smooth', block: 'start' });
  });

  it('scrolls without animation for people who prefer reduced motion', async () => {
    const page = installPage({ panel: true, reducedMotion: true });
    (await link()).onClick();
    page.runFrames();
    expect(page.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
  });

  it('does nothing by hand when the panel is not on the page yet', async () => {
    const page = installPage({ panel: false });
    (await link()).onClick();
    page.runFrames();
    const { revealCoverage } = await import('@/components/shell/coverage-indicator');
    expect(revealCoverage()).toBe(false);
  });
});

describe('the coverage panel', () => {
  it('brings itself into view when it appears with #coverage in the address', async () => {
    const page = installPage({ panel: true, hash: '#coverage' });
    const { CoveragePanel } = await import('@/features/overview/coverage-panel');
    CoveragePanel({ coverage });
    expect(page.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('stays where it is without #coverage in the address', async () => {
    const page = installPage({ panel: true, hash: '' });
    const { CoveragePanel } = await import('@/features/overview/coverage-panel');
    CoveragePanel({ coverage });
    expect(page.scrollIntoView).not.toHaveBeenCalled();
  });
});

'use client';

import { useEffect, useRef, useState } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { cn } from '@/lib/cn';
import { useCoverage } from '@/state/queries';
import { AboutSection } from './about-section';
import { BackupSection } from './backup-section';
import { DangerSection } from './danger-section';
import { DisplaySection } from './display-section';
import { PricesSection } from './prices-section';
import { usePrices } from './queries';
import { SourcesSection } from './sources-section';

const SECTIONS = [
  { id: 'display', label: 'Display and accounting' },
  { id: 'sources', label: 'Data sources' },
  { id: 'prices', label: 'Prices' },
  { id: 'backup', label: 'Backup and storage' },
  { id: 'delete-data', label: 'Delete data' },
  { id: 'about', label: 'About' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

/** How far below the top of the window a section starts to count as the one being read: just under the two sticky bars. */
const READING_LINE = 132;

/** The section the reader is in, so the list above can show where they are. */
function useActiveSection(): SectionId {
  const [active, setActive] = useState<SectionId>(SECTIONS[0].id);
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      let current: SectionId = SECTIONS[0].id;
      for (const section of SECTIONS) {
        const element = document.getElementById(section.id);
        if (element && element.getBoundingClientRect().top <= READING_LINE) current = section.id;
      }
      // The last sections are short: at the end of the page they would never reach the line.
      const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      if (atEnd && window.scrollY > 0) current = SECTIONS[SECTIONS.length - 1].id;
      setActive(current);
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    schedule();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, []);
  return active;
}

function SectionList({ active }: { active: SectionId }) {
  const list = useRef<HTMLUListElement>(null);

  // On narrow screens the list scrolls sideways; keep the current entry in view.
  useEffect(() => {
    const container = list.current;
    const link = container?.querySelector<HTMLElement>(`[data-section="${active}"]`);
    if (!container || !link) return;
    const left = link.offsetLeft;
    const right = left + link.offsetWidth;
    if (left < container.scrollLeft || right > container.scrollLeft + container.clientWidth) {
      container.scrollTo({ left: Math.max(0, left - 16), behavior: 'smooth' });
    }
  }, [active]);

  return (
    <nav aria-label="Sections of this page" className="sticky top-14 z-10 mb-8 border-b border-line bg-page/85 backdrop-blur-md">
      <ul ref={list} className="relative flex gap-1 overflow-x-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {SECTIONS.map((section) => (
          <li key={section.id} className="shrink-0">
            <a
              href={`#${section.id}`}
              data-section={section.id}
              aria-current={active === section.id ? 'location' : undefined}
              className={cn(
                'flex h-8 items-center rounded-[var(--radius-control)] px-2.5 text-[13px] transition-colors',
                active === section.id ? 'bg-raised text-ink' : 'text-ink-2 hover:bg-raised/60 hover:text-ink',
              )}
            >
              {section.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Settings: one column of sections. Nothing here follows the date range in the top
 * bar; the figures shown next to a preference are lifetime figures.
 *
 * The page is shown whether or not anything has been imported: preferences, prices and
 * restoring a backup all make sense in an empty workspace. Only the list of sources has
 * an empty state.
 */
export function SettingsPage({ appVersion }: { appVersion: string }) {
  const active = useActiveSection();
  const coverage = useCoverage();
  const prices = usePrices();
  const settled = (coverage.data !== undefined || coverage.error !== null) && (prices.data !== undefined || prices.error !== null);

  // A link such as /settings/#prices arrives before the page has content, and the sections above the
  // target grow as they load: go to the target once at the start and once more when everything is in.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id !== '') document.getElementById(id)?.scrollIntoView();
  }, [settled]);

  return (
    <div>
      <PageHeader
        title="Settings"
        description="How usage is counted and valued, the sources and prices behind every figure, and tools to back up or delete what is stored on this device."
        className="mb-4"
      />
      <SectionList active={active} />
      <div className="space-y-12">
        <DisplaySection />
        <SourcesSection />
        <PricesSection />
        <BackupSection />
        <DangerSection />
        <AboutSection appVersion={appVersion} />
      </div>
    </div>
  );
}

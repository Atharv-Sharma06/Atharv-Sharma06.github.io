'use client';

import { ArrowUpRight, FlaskConical, HardDrive, Menu, Upload, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Dialog as RDialog } from 'radix-ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, buttonClass } from '@/components/ui/button';
import { Segmented } from '@/components/ui/controls';
import { Tooltip, TooltipProvider } from '@/components/ui/overlay';
import { deleteAllData } from '@/import/delete';
import { cn } from '@/lib/cn';
import { useApp, useAppState } from '@/state/app';
import { useCoverage } from '@/state/queries';
import { BootError, BootScreen, Paused } from './boot';
import { CoverageIndicator } from './coverage-indicator';
import { DateRangePicker } from './date-range';
import { isActive, NAV, NAV_SECONDARY, type NavItem } from './nav';
import { RefreshStatus } from './refresh-status';

/** The portfolio this app is a sub-page of: the root of the same site. */
const PORTFOLIO_HOME = '/';

/** Pages whose figures follow the date range. The others always cover the whole history. */
const RANGE_ROUTES = ['/', '/usage/', '/conversations/', '/models/'];

/**
 * Opt-in background sync of the remembered Claude Code folder, once per page load.
 * It only runs when the user switched it on and the browser already allows reading
 * the folder, and it never opens a permission prompt.
 */
function AutoSync() {
  const app = useApp();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      const { autoSyncEnabled } = await import('@/features/import/local-files');
      if (!(await autoSyncEnabled())) return;
      const { syncClaudeCodeFolder } = await import('@/features/import/background-sync');
      const outcome = await syncClaudeCodeFolder(app.db, app.userId, false);
      if (outcome && !outcome.problem && outcome.added > 0) app.notifyDataChanged();
    })();
  }, [app]);
  return null;
}

function Mark({ className }: { className?: string }) {
  // Three strata that grow: usage accumulating over a lifetime.
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <rect x="3" y="15.5" width="18" height="4.5" rx="1.6" fill="var(--color-accent)" />
      <rect x="3" y="9.75" width="12.5" height="4.5" rx="1.6" fill="var(--color-accent)" opacity="0.62" />
      <rect x="3" y="4" width="7" height="4.5" rx="1.6" fill="var(--color-accent)" opacity="0.34" />
    </svg>
  );
}

function NavLink({ item, pathname, onNavigate }: { item: NavItem; pathname: string; onNavigate?: () => void }) {
  const active = isActive(pathname, item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex h-9 items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 text-sm transition-colors',
        active ? 'bg-raised text-ink' : 'text-ink-2 hover:bg-raised/60 hover:text-ink',
      )}
    >
      <Icon className={cn('size-4 shrink-0', active ? 'text-accent-soft' : 'text-ink-3 group-hover:text-ink-2')} aria-hidden="true" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

function SidebarContent({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <>
      <Link href="/" onClick={onNavigate} className="flex h-14 shrink-0 items-center gap-2.5 px-4">
        <Mark className="size-6" />
        <span className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Claude Lifetime</span>
      </Link>
      <nav aria-label="Sections" className="scrollbar-thin flex-1 overflow-y-auto px-2.5 pb-3 pt-1">
        <ul className="space-y-0.5">
          {NAV.map((item) => (
            <li key={item.href}>
              <NavLink item={item} pathname={pathname} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
        <ul className="mt-4 space-y-0.5 border-t border-line pt-4">
          {NAV_SECONDARY.map((item) => (
            <li key={item.href}>
              <NavLink item={item} pathname={pathname} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
      </nav>
      <div className="shrink-0 border-t border-line px-4 py-3 text-xs text-ink-3">
        <p className="flex items-start gap-2">
          <HardDrive className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>Your data stays in this browser. Nothing is uploaded.</span>
        </p>
        {/* A plain link on purpose: the portfolio is a separate site outside this app's router and base path. */}
        <a href={PORTFOLIO_HOME} className="mt-2.5 inline-flex items-center gap-1 text-ink-2 hover:text-ink">
          Atharv Sharma&rsquo;s portfolio
          <ArrowUpRight className="size-3.5" aria-hidden="true" />
        </a>
      </div>
    </>
  );
}

function BasisToggle() {
  const { settings, saveSettings } = useApp();
  return (
    <Tooltip
      content={
        <span>
          <strong className="font-medium">Processed</strong> counts everything the model read and wrote, including context that is re-read on every turn.{' '}
          <strong className="font-medium">New</strong> counts each piece of content once.
        </span>
      }
      side="bottom"
    >
      <span>
        <Segmented
          label="Token basis"
          value={settings.basis}
          onChange={(basis) => void saveSettings({ basis })}
          options={[
            { value: 'processed', label: 'Processed' },
            { value: 'new', label: 'New' },
          ]}
        />
      </span>
    </Tooltip>
  );
}

function DemoBanner() {
  const app = useApp();
  const { data } = useCoverage();
  const [busy, setBusy] = useState(false);
  if (!data?.hasSyntheticData) return null;
  return (
    <div role="status" className="border-b border-warning/30 bg-warning/[0.07]">
      <div className="mx-auto flex w-full max-w-[1280px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6 lg:px-8">
        <p className="flex min-w-0 flex-1 basis-64 items-start gap-2 text-[13px] text-ink">
          <FlaskConical className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <span>
            <strong className="font-medium">Synthetic demo data.</strong> Every figure on this page is invented to show how the app works. None of it is
            your Claude usage.
          </span>
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await deleteAllData(app.db, app.userId);
                app.notifyDataChanged();
              } finally {
                setBusy(false);
              }
            }}
          >
            Remove demo data
          </Button>
          <Link href="/import/" className={buttonClass('primary', 'sm')}>
            Import your own
          </Link>
        </div>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const state = useAppState();
  const [menuOpen, setMenuOpen] = useState(false);
  const ready = state.status === 'ready';

  return (
    <TooltipProvider>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-raised focus:px-3 focus:py-2 focus:text-ink"
      >
        Skip to content
      </a>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[236px] flex-col border-r border-line bg-page lg:flex">
        <SidebarContent pathname={pathname} />
      </aside>

      <RDialog.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <RDialog.Portal>
          <RDialog.Overlay className="fixed inset-0 z-40 animate-[fade-in_120ms_ease-out] bg-black/60 lg:hidden" />
          <RDialog.Content
            aria-describedby={undefined}
            className="fixed inset-y-0 left-0 z-50 flex w-[min(280px,86vw)] animate-[fade-in_120ms_ease-out] flex-col border-r border-line-strong bg-page lg:hidden"
          >
            <RDialog.Title className="sr-only">Sections</RDialog.Title>
            <RDialog.Close className="absolute right-2.5 top-3 rounded-md p-2 text-ink-3 hover:bg-raised hover:text-ink" aria-label="Close menu">
              <X className="size-4" aria-hidden="true" />
            </RDialog.Close>
            <SidebarContent pathname={pathname} onNavigate={() => setMenuOpen(false)} />
          </RDialog.Content>
        </RDialog.Portal>
      </RDialog.Root>

      <div className="flex min-h-dvh flex-col lg:pl-[236px]">
        <header className="sticky top-0 z-20 border-b border-line bg-page/80 backdrop-blur-md">
          <div className="mx-auto flex h-14 w-full max-w-[1280px] items-center gap-2 px-4 sm:px-6 lg:px-8">
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label="Open menu"
              className="-ml-2 rounded-md p-2 text-ink-2 hover:bg-raised hover:text-ink lg:hidden"
            >
              <Menu className="size-5" aria-hidden="true" />
            </button>
            {ready ? (
              <>
                <div className="min-w-0 shrink">
                  <DateRangePicker applies={RANGE_ROUTES.some((href) => isActive(pathname, href))} />
                </div>
                <div className="hidden md:block">
                  <BasisToggle />
                </div>
                <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
                  <RefreshStatus />
                  <CoverageIndicator />
                  <Link href="/import/" className={buttonClass('primary', 'md', 'px-3')} aria-label="Import data">
                    <Upload className="size-4" aria-hidden="true" />
                    <span className="hidden sm:inline">Import data</span>
                  </Link>
                </div>
              </>
            ) : (
              <span className="text-[15px] font-semibold text-ink lg:hidden">Claude Lifetime</span>
            )}
          </div>
        </header>

        {ready ? <DemoBanner /> : null}
        {ready ? <AutoSync /> : null}

        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1280px] flex-1 px-4 pb-20 pt-7 outline-none sm:px-6 lg:px-8">
          {state.status === 'ready' ? (
            children
          ) : state.status === 'error' ? (
            <BootError error={state.error} retry={state.retry} />
          ) : state.status === 'paused' ? (
            <Paused />
          ) : (
            <BootScreen phase={state.phase} />
          )}
        </main>
      </div>
    </TooltipProvider>
  );
}

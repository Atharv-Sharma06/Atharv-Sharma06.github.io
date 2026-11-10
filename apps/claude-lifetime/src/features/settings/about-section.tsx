'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/feedback';
import { CATALOG_VERSION, ESTIMATOR_VERSION, RETRIEVED_ON } from '@/core/catalog';
import { formatDay } from '@/lib/format';
import { useData } from '@/state/app';
import { parsePostgresVersion } from './logic';
import { SettingsSection } from './parts';

function Entry({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-10 gap-y-0.5 px-5 py-3 text-[13px] sm:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
      <dt className="text-ink-2">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  );
}

export function AboutSection({ appVersion }: { appVersion: string }) {
  const server = useData(['settings', 'postgres-version'], async (app) => {
    const { rows } = await app.db.query<{ version: string }>('SELECT version() AS version');
    return rows[0]?.version ?? '';
  });
  const version = server.data ? parsePostgresVersion(server.data) : null;

  return (
    <SettingsSection id="about" title="About">
      <Card>
        <dl className="divide-y divide-line">
          <Entry label="Application">Claude Lifetime {appVersion}</Entry>
          <Entry label="Database">
            {server.error ? (
              <span className="text-ink-2">The version could not be read: {server.error.message}</span>
            ) : !version ? (
              <span aria-busy="true">
                <Skeleton className="h-5 w-56 max-w-full" />
              </span>
            ) : (
              <span title={server.data}>
                {version.postgres ? `PostgreSQL ${version.postgres}` : server.data}
                {version.engine ? ` (${version.engine})` : ''}, running inside this browser
              </span>
            )}
          </Entry>
          <Entry label="Model and price catalog">
            Version {CATALOG_VERSION}, with prices read on {formatDay(RETRIEVED_ON)}
          </Entry>
          <Entry label="Token estimator">{ESTIMATOR_VERSION}</Entry>
          <Entry label="Method">
            <Link href="/methodology/" className="text-accent-soft underline-offset-4 hover:underline">
              How it is counted
            </Link>
          </Entry>
        </dl>
      </Card>
    </SettingsSection>
  );
}

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { AppProviders } from '@/state/app';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Claude Lifetime', template: '%s · Claude Lifetime' },
  description:
    'Your entire history with Claude, quantified. Import your own exports and logs, and see lifetime tokens, conversations, models and subscription periods. Everything stays in your browser.',
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: '#09090c',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppProviders>
          <AppShell>{children}</AppShell>
        </AppProviders>
      </body>
    </html>
  );
}

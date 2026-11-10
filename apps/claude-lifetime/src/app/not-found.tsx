import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonClass } from '@/components/ui/button';

export const metadata: Metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <div className="max-w-[60ch]">
      <h1 className="text-[22px] font-medium text-ink">This page does not exist</h1>
      <p className="mt-2 text-ink-2">
        The address may be mistyped, or the page may have moved. Your data is not affected: it is stored in this browser, not at an address.
      </p>
      <Link href="/" className={buttonClass('primary', 'md', 'mt-5')}>
        Open the overview
      </Link>
    </div>
  );
}

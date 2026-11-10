import type { Metadata } from 'next';
import { MethodologyPage } from '@/features/methodology/methodology-page';

export const metadata: Metadata = { title: 'How it is counted' };

export default function Page() {
  return <MethodologyPage />;
}

import type { Metadata } from 'next';
import { ModelsPage } from '@/features/models/models-page';

export const metadata: Metadata = { title: 'Model Breakdown' };

export default function Page() {
  return <ModelsPage />;
}

import type { Metadata } from 'next';
import { ActivityPage } from '@/features/activity/activity-page';

export const metadata: Metadata = { title: 'Activity Heatmap' };

export default function Page() {
  return <ActivityPage />;
}

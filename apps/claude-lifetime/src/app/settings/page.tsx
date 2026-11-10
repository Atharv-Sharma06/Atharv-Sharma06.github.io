import type { Metadata } from 'next';
import { SettingsPage } from '@/features/settings/settings-page';
import packageJson from '../../../package.json';

export const metadata: Metadata = { title: 'Settings' };

export default function Page() {
  return <SettingsPage appVersion={packageJson.version} />;
}

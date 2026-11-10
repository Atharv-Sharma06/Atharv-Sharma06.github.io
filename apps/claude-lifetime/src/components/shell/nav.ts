import {
  BookOpen,
  CalendarRange,
  ChartArea,
  ChartPie,
  Grid3x3,
  LayoutDashboard,
  MessagesSquare,
  Settings,
  Upload,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const NAV: NavItem[] = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/usage/', label: 'Lifetime Usage', icon: ChartArea },
  { href: '/subscriptions/', label: 'Subscription History', icon: CalendarRange },
  { href: '/conversations/', label: 'Conversations', icon: MessagesSquare },
  { href: '/models/', label: 'Model Breakdown', icon: ChartPie },
  { href: '/activity/', label: 'Activity Heatmap', icon: Grid3x3 },
  { href: '/import/', label: 'Import Data', icon: Upload },
  { href: '/settings/', label: 'Settings', icon: Settings },
];

export const NAV_SECONDARY: NavItem[] = [{ href: '/methodology/', label: 'How it is counted', icon: BookOpen }];

export function isActive(pathname: string, href: string): boolean {
  const path = pathname.endsWith('/') ? pathname : `${pathname}/`;
  return href === '/' ? path === '/' : path.startsWith(href);
}

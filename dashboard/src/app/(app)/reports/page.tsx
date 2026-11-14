import { NoAccess } from '@/components/me';
import { Reports } from '@/components/Reports';
import { getMe } from '@/lib/session';

export const metadata = { title: 'Reports — Snag' };

export default async function ReportsPage() {
  const me = await getMe();
  if (!me?.permissions.includes('tickets.view')) return <NoAccess what="reports" />;
  return <Reports />;
}

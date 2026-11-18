import { Teams } from '@/components/Teams';
import { NoAccess } from '@/components/me';
import { getMe } from '@/lib/session';

export const metadata = { title: 'Teams — Snag' };

export default async function TeamsPage() {
  const me = await getMe();
  if (!me?.permissions.includes('tickets.view')) return <NoAccess what="teams" />;
  return <Teams />;
}

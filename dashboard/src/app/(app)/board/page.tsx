import { Board } from '@/components/Board';
import { NoAccess } from '@/components/me';
import { getMe } from '@/lib/session';

export const metadata = { title: 'Board — Snag' };

export default async function BoardPage() {
  const me = await getMe();
  if (!me?.permissions.includes('tickets.view')) return <NoAccess what="the board" />;
  return <Board />;
}

import { Users } from '@/components/Users';
import { NoAccess } from '@/components/me';
import { getMe } from '@/lib/session';

export const metadata = { title: 'Users — Snag' };

export default async function UsersPage() {
  const me = await getMe();
  if (!me?.permissions.includes('users.manage')) return <NoAccess what="user management" />;
  return <Users />;
}

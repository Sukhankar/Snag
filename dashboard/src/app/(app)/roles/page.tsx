import { Roles } from '@/components/Roles';
import { NoAccess } from '@/components/me';
import { getMe } from '@/lib/session';

export const metadata = { title: 'Roles — Snag' };

export default async function RolesPage() {
  const me = await getMe();
  if (!me?.permissions.includes('roles.manage')) return <NoAccess what="roles and permissions" />;
  return <Roles />;
}

import { Suspense } from 'react';
import { Inbox } from '@/components/Inbox';
import { NoAccess } from '@/components/me';
import { getMe } from '@/lib/session';

export default async function InboxPage() {
  const me = await getMe();
  if (!me?.permissions.includes('tickets.view')) return <NoAccess what="the inbox" />;
  return (
    <Suspense>
      <Inbox />
    </Suspense>
  );
}

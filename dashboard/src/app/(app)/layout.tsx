import { redirect } from 'next/navigation';
import { Shell } from '@/components/Shell';
import { getMe } from '@/lib/session';

// Every page in this group requires a valid session. The Go server re-checks the session and
// the user's permissions on every API call, so hiding UI here is convenience, not security.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await getMe();
  if (!me) redirect('/login');
  return <Shell me={me}>{children}</Shell>;
}

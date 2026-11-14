import { Projects } from '@/components/Projects';
import { NoAccess } from '@/components/me';
import { getMe } from '@/lib/session';

export const metadata = { title: 'Projects — Snag' };

export default async function ProjectsPage() {
  const me = await getMe();
  if (!me?.permissions.includes('projects.view')) return <NoAccess what="projects" />;
  return <Projects />;
}

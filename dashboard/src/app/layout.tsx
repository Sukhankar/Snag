import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Snag — Operations',
  description: 'Cross-project issue triage',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'NanoClaw Dashboard',
  description: 'System status and management for NanoClaw',
};

const nav = [
  { href: '/', label: 'Overview' },
  { href: '/groups', label: 'Groups' },
  { href: '/messages', label: 'Messages' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/books', label: 'Books' },
  { href: '/memories', label: 'Memories' },
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen font-mono">
        <div className="flex">
          <nav className="w-48 shrink-0 border-r border-[var(--border)] min-h-screen p-4 flex flex-col gap-1">
            <Link
              href="/"
              className="text-lg font-bold mb-4 block text-[var(--accent)]"
            >
              NanoClaw
            </Link>
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="block px-3 py-1.5 rounded text-sm text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)] transition-colors"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <main className="flex-1 p-6 min-w-0">{children}</main>
        </div>
      </body>
    </html>
  );
}

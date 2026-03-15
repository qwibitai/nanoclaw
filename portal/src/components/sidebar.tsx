'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { setToken } from '@/lib/api-client';

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: '~' },
  { href: '/agents', label: 'Agents', icon: '>' },
  { href: '/teams', label: 'Teams', icon: '#' },
  { href: '/knowledge', label: 'Knowledge Base', icon: '?' },
  { href: '/tickets', label: 'Tickets', icon: '!' },
  { href: '/chat', label: 'Chat', icon: '@' },
  { href: '/logs', label: 'Audit Logs', icon: '*' },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();

  const handleLogout = () => {
    setToken(null);
    router.push('/login');
  };

  return (
    <div className="sidebar">
      <div className="sidebar-logo">Agent Manager</div>
      <nav className="sidebar-nav">
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`sidebar-link ${pathname.startsWith(item.href) ? 'active' : ''}`}
          >
            <span style={{ fontFamily: 'monospace', width: 16, textAlign: 'center' }}>
              {item.icon}
            </span>
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="sidebar-user">
        <button onClick={handleLogout} className="btn btn-sm" style={{ width: '100%' }}>
          Sign Out
        </button>
      </div>
    </div>
  );
}

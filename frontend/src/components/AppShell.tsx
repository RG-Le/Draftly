import { NavLink } from 'react-router-dom';
import type { User } from '../types';
import { Button } from './Button';

interface AppShellProps {
  user?: User | null;
  onLogout: () => void;
  children: React.ReactNode;
}

const navItems = [
  { to: '/app/inbox', label: 'Inbox' },
  { to: '/app/drafts', label: 'Drafts' },
  { to: '/app/sent', label: 'Sent' },
  { to: '/app/usage', label: 'Usage' },
  { to: '/app/settings', label: 'Settings' }
];

export function AppShell({ user, onLogout, children }: AppShellProps) {
  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="brand">
          <p className="brand-kicker">Draftly</p>
          <h1>Editorial Ops Desk</h1>
        </div>

        <nav className="nav">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `nav-link ${isActive ? 'nav-link-active' : ''}`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <p className="user-name">{user?.name || 'Workspace user'}</p>
          <p className="user-email">{user?.email || ''}</p>
          <Button variant="ghost" onClick={onLogout}>
            Log out
          </Button>
        </div>
      </aside>

      <main className="app-main">{children}</main>
    </div>
  );
}

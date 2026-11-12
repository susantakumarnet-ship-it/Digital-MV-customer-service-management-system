import { NavLink } from 'react-router-dom';
import { ChevronsLeft, ChevronsRight } from 'lucide-react';
import { useAuth } from '@/features/auth/auth-context';
import { BrandMark } from '@/features/auth/auth-layout';
import { cn } from '@/lib/utils';
import { visibleNav } from '../navigation';

export function SidebarNav({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { hasAny } = useAuth();
  const groups = visibleNav(hasAny);
  return (
    <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 py-3">
      {groups.map((g, gi) => (
        <div key={g.label ?? gi} className="mb-4">
          {g.label && !collapsed && <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-navy-300">{g.label}</p>}
          {g.label && collapsed && <div className="mx-3 mb-2 h-px bg-navy-700" aria-hidden />}
          <ul className="space-y-0.5">
            {g.items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  onClick={onNavigate}
                  title={collapsed ? item.label : undefined}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                      isActive ? 'bg-royal-700 text-white' : 'text-navy-100 hover:bg-navy-800 hover:text-white',
                      collapsed && 'justify-center px-0',
                    )
                  }
                >
                  <item.icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
                  <span className={cn(collapsed && 'sr-only')}>{item.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <aside
      className={cn(
        'sticky top-0 hidden h-screen shrink-0 flex-col bg-navy-900 text-white transition-[width] duration-200 lg:flex',
        collapsed ? 'w-[72px]' : 'w-64',
      )}
    >
      <div className={cn('flex h-16 items-center gap-3 border-b border-navy-800 px-4', collapsed && 'justify-center px-0')}>
        <BrandMark className="h-8 w-8 shrink-0" />
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold">Digital MV</p>
            <p className="truncate text-[11px] text-navy-300">Customer Service Management</p>
          </div>
        )}
      </div>
      <SidebarNav collapsed={collapsed} />
      <button
        type="button"
        onClick={onToggle}
        className="flex h-11 items-center justify-center gap-2 border-t border-navy-800 text-xs text-navy-200 hover:bg-navy-800 hover:text-white"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!collapsed}
      >
        {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
        {!collapsed && 'Collapse'}
      </button>
    </aside>
  );
}

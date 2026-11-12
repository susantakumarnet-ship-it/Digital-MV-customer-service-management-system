import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { LogOut, Menu, UserCog, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuth } from '@/features/auth/auth-context';
import { BrandMark } from '@/features/auth/auth-layout';
import { initials, safeStorage } from '@/lib/utils';
import { BreadcrumbProvider, Breadcrumbs } from '../breadcrumbs';
import { NotificationBell } from './notification-bell';
import { Sidebar, SidebarNav } from './sidebar';

const COLLAPSE_KEY = 'mv.sidebar.collapsed';

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(() => safeStorage.get(COLLAPSE_KEY) === '1');
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setMobileOpen(false), [location.pathname]);

  const toggle = () =>
    setCollapsed((c) => {
      safeStorage.set(COLLAPSE_KEY, c ? '0' : '1');
      return !c;
    });

  return (
    <BreadcrumbProvider>
      <div className="flex min-h-screen">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:p-2">
          Skip to content
        </a>
        <Sidebar collapsed={collapsed} onToggle={toggle} />

        {/* Mobile off-canvas navigation */}
        <DialogPrimitive.Root open={mobileOpen} onOpenChange={setMobileOpen}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-navy-950/50 lg:hidden" />
            <DialogPrimitive.Content
              className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col bg-navy-900 text-white animate-slide-in-left lg:hidden"
              aria-describedby={undefined}
            >
              <div className="flex h-16 items-center justify-between border-b border-navy-800 px-4">
                <div className="flex items-center gap-3">
                  <BrandMark className="h-8 w-8" />
                  <DialogPrimitive.Title className="text-sm font-semibold">Digital MV</DialogPrimitive.Title>
                </div>
                <DialogPrimitive.Close className="rounded p-1 text-navy-200 hover:bg-navy-800" aria-label="Close menu">
                  <X className="h-5 w-5" />
                </DialogPrimitive.Close>
              </div>
              <SidebarNav collapsed={false} onNavigate={() => setMobileOpen(false)} />
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-white/95 px-4 backdrop-blur sm:px-6">
            <button
              type="button"
              className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="min-w-0 flex-1">
              <Breadcrumbs />
            </div>
            <NotificationBell />
            <UserMenu />
          </header>
          <main id="main" className="min-w-0 flex-1 px-4 py-5 sm:px-6 sm:py-6">
            <Outlet />
          </main>
        </div>
      </div>
    </BreadcrumbProvider>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex items-center gap-2 rounded-lg p-1 pr-2 hover:bg-slate-100" aria-label="Account menu">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-navy-900 text-xs font-semibold text-white">{initials(user.name)}</span>
          <span className="hidden max-w-[10rem] truncate text-left text-sm sm:block">
            <span className="block truncate font-medium text-navy-900">{user.name}</span>
            <span className="block truncate text-xs text-slate-500">{user.roles.map((r) => r.name).join(', ')}</span>
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel className="normal-case tracking-normal">
          <span className="block truncate text-sm font-semibold text-navy-900">{user.name}</span>
          <span className="block truncate text-xs font-normal text-slate-500">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/profile">
            <UserCog className="h-4 w-4" /> Profile & Security
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={async () => {
            try {
              await logout();
            } catch {
              toast.error('Sign-out could not reach the server; you have been signed out on this device.');
            }
            navigate('/login', { replace: true });
          }}
        >
          <LogOut className="h-4 w-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

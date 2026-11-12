import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import { toast } from 'sonner';
import type { Paged } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { api, errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import type { NotificationDto } from '@/lib/types';
import { cn } from '@/lib/utils';

const SEVERITY_DOT: Record<NotificationDto['severity'], string> = {
  info: 'bg-royal-600',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
};

export function useUnreadCount() {
  return useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: async () => (await api.get<{ count: number }>('/notifications/unread-count')).data.count,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string | 'all') => (id === 'all' ? api.post('/notifications/read-all') : api.post(`/notifications/${id}/read`)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function NotificationBell() {
  const navigate = useNavigate();
  const unread = useUnreadCount();
  const count = unread.data ?? 0;
  const list = useQuery({
    queryKey: ['notifications', 'latest'],
    queryFn: async () => (await api.get<Paged<NotificationDto>>('/notifications', { params: { limit: 10 } })).data.data,
    staleTime: 15_000,
  });
  const markRead = useMarkRead();

  return (
    <DropdownMenu onOpenChange={(o) => o && list.refetch()}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative rounded-lg p-2 text-slate-600 hover:bg-slate-100"
          aria-label={count ? `Notifications, ${count} unread` : 'Notifications'}
        >
          <Bell className="h-5 w-5" />
          {count > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
              {count > 99 ? '99+' : count}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[min(22rem,calc(100vw-1.5rem))] p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <p className="text-sm font-semibold text-navy-900">Notifications</p>
          <Button variant="ghost" size="sm" disabled={!count || markRead.isPending} onClick={() => markRead.mutate('all')}>
            <CheckCheck className="h-4 w-4" /> Mark all read
          </Button>
        </div>
        <div className="max-h-96 overflow-y-auto p-1">
          {list.isLoading && (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          )}
          {list.isError && <p className="px-3 py-6 text-center text-sm text-red-600">{errorMessage(list.error)}</p>}
          {list.data?.length === 0 && <p className="px-3 py-6 text-center text-sm text-slate-500">You're all caught up.</p>}
          {list.data?.map((n) => (
            <DropdownMenuItem
              key={n.id}
              className="items-start"
              onSelect={() => {
                if (!n.readAt) markRead.mutate(n.id);
                if (n.link) navigate(n.link);
              }}
            >
              <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : SEVERITY_DOT[n.severity])} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className={cn('block text-sm', n.readAt ? 'text-slate-600' : 'font-medium text-navy-900')}>{n.title}</span>
                {n.body && <span className="block truncate text-xs text-slate-500">{n.body}</span>}
                <span className="block text-[11px] text-slate-400">{timeAgo(n.createdAt)}</span>
              </span>
            </DropdownMenuItem>
          ))}
        </div>
        <div className="border-t border-border p-1">
          <DropdownMenuItem asChild>
            <Link to="/notifications" className="justify-center text-royal-700">
              View all notifications
            </Link>
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

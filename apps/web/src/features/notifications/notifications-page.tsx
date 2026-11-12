import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CheckCheck } from 'lucide-react';
import type { Paged } from '@mv/shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/form';
import { Pagination } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState } from '@/components/states';
import { useMarkRead } from '@/app/layout/notification-bell';
import { api } from '@/lib/api';
import { formatDateTime, timeAgo } from '@/lib/format';
import type { NotificationDto } from '@/lib/types';
import { cn } from '@/lib/utils';

export function NotificationsPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const markRead = useMarkRead();
  const q = useQuery({
    queryKey: ['notifications', 'page', page, unreadOnly],
    queryFn: async () =>
      (await api.get<Paged<NotificationDto>>('/notifications', { params: { page, limit: 20, unread: unreadOnly ? 'true' : undefined } })).data,
    placeholderData: keepPreviousData,
  });
  const hasUnread = q.data?.data.some((n) => !n.readAt);

  return (
    <div>
      <PageHeader
        title="Notifications"
        actions={
          <>
            <Select
              aria-label="Filter notifications"
              className="w-auto"
              value={unreadOnly ? 'unread' : 'all'}
              onChange={(e) => {
                setUnreadOnly(e.target.value === 'unread');
                setPage(1);
              }}
            >
              <option value="all">All</option>
              <option value="unread">Unread only</option>
            </Select>
            <Button variant="outline" disabled={markRead.isPending || (!hasUnread && !unreadOnly)} onClick={() => markRead.mutate('all')}>
              <CheckCheck className="h-4 w-4" /> Mark all read
            </Button>
          </>
        }
      />
      <Card>
        {q.isLoading ? (
          <div className="space-y-3 p-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="skeleton h-10" />
            ))}
          </div>
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.data.length ? (
          <EmptyState title={unreadOnly ? 'No unread notifications' : 'No notifications yet'} />
        ) : (
          <>
            <ul className="divide-y divide-border">
              {q.data.data.map((n) => (
                <li key={n.id} className={cn('flex flex-wrap items-start gap-3 px-5 py-3', !n.readAt && 'bg-royal-50/40')}>
                  <span className={cn('mt-2 h-2 w-2 shrink-0 rounded-full', n.readAt ? 'bg-slate-200' : 'bg-royal-600')} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className={cn('text-sm', n.readAt ? 'text-slate-700' : 'font-semibold text-navy-900')}>{n.title}</p>
                    {n.body && <p className="text-sm text-slate-500">{n.body}</p>}
                    <time className="text-xs text-slate-400" dateTime={n.createdAt} title={formatDateTime(n.createdAt)}>
                      {timeAgo(n.createdAt)}
                    </time>
                  </div>
                  <div className="flex gap-1">
                    {n.link && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (!n.readAt) markRead.mutate(n.id);
                          navigate(n.link!);
                        }}
                      >
                        Open
                      </Button>
                    )}
                    {!n.readAt && (
                      <Button variant="ghost" size="sm" onClick={() => markRead.mutate(n.id)}>
                        Mark read
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <Pagination page={page} pages={q.data.meta.pages} total={q.data.meta.total} limit={q.data.meta.limit} onPageChange={setPage} disabled={q.isFetching} />
          </>
        )}
      </Card>
    </div>
  );
}

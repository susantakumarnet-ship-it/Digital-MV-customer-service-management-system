import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { EmptyState, ErrorState } from './states';

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Server sort field; when set the header is clickable. */
  sortKey?: string;
  className?: string;
  /** Hide on small screens. */
  hideOnMobile?: boolean;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  sort?: string;
  onSortChange?: (sort: string) => void;
  page?: number;
  pages?: number;
  total?: number;
  limit?: number;
  onPageChange?: (page: number) => void;
  onRowClick?: (row: T) => void;
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  emptyAction?: ReactNode;
  caption?: string;
}

/** Server-driven table: sorting, pagination, loading skeleton, empty and error states. */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  error,
  onRetry,
  sort,
  onSortChange,
  page = 1,
  pages = 1,
  total,
  limit,
  onPageChange,
  onRowClick,
  emptyTitle = 'No records found',
  emptyDescription,
  emptyAction,
  caption,
}: DataTableProps<T>) {
  if (error && !loading) return <ErrorState error={error} onRetry={onRetry} />;

  const sortField = sort?.replace(/^-/, '');
  const desc = sort?.startsWith('-');
  const toggleSort = (key: string) => onSortChange?.(sortField === key && !desc ? `-${key}` : key);

  const showEmpty = !loading && (rows?.length ?? 0) === 0;

  return (
    <div className="min-w-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead className="border-b border-border bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cn('whitespace-nowrap px-4 py-3 font-semibold', c.hideOnMobile && 'hidden md:table-cell', c.className)}
                  aria-sort={sortField === c.sortKey && c.sortKey ? (desc ? 'descending' : 'ascending') : undefined}
                >
                  {c.sortKey && onSortChange ? (
                    <button type="button" className="inline-flex items-center gap-1 hover:text-navy-900" onClick={() => toggleSort(c.sortKey!)}>
                      {c.header}
                      {sortField === c.sortKey ? (
                        desc ? (
                          <ArrowDown className="h-3 w-3" />
                        ) : (
                          <ArrowUp className="h-3 w-3" />
                        )
                      ) : (
                        <ArrowUpDown className="h-3 w-3 opacity-40" />
                      )}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading
              ? Array.from({ length: 5 }).map((_, i) => (
                  <tr key={`sk-${i}`} data-testid="skeleton-row">
                    {columns.map((c) => (
                      <td key={c.key} className={cn('px-4 py-3', c.hideOnMobile && 'hidden md:table-cell')}>
                        <div className="skeleton h-4 w-3/4" />
                      </td>
                    ))}
                  </tr>
                ))
              : rows?.map((r) => (
                  <tr
                    key={rowKey(r)}
                    className={cn('bg-white', onRowClick && 'cursor-pointer hover:bg-slate-50')}
                    onClick={onRowClick ? () => onRowClick(r) : undefined}
                    onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(r) : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                  >
                    {columns.map((c) => (
                      <td key={c.key} className={cn('px-4 py-3 align-middle', c.hideOnMobile && 'hidden md:table-cell', c.className)}>
                        {c.cell(r)}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      {showEmpty && <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />}
      {onPageChange && !showEmpty && (
        <Pagination page={page} pages={pages} total={total} limit={limit} onPageChange={onPageChange} disabled={loading} />
      )}
    </div>
  );
}

export function Pagination({
  page,
  pages,
  total,
  limit,
  onPageChange,
  disabled,
}: {
  page: number;
  pages: number;
  total?: number;
  limit?: number;
  onPageChange: (p: number) => void;
  disabled?: boolean;
}) {
  const from = total && limit ? (page - 1) * limit + 1 : undefined;
  const to = total && limit ? Math.min(page * limit, total) : undefined;
  return (
    <nav className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-sm text-slate-600" aria-label="Pagination">
      <span>{total !== undefined && from ? `${from}–${to} of ${total}` : `Page ${page} of ${pages}`}</span>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" disabled={disabled || page <= 1} onClick={() => onPageChange(page - 1)} aria-label="Previous page">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="px-2">
          {page} / {pages}
        </span>
        <Button variant="outline" size="sm" disabled={disabled || page >= pages} onClick={() => onPageChange(page + 1)} aria-label="Next page">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </nav>
  );
}

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { STATUS_TONES } from '@mv/shared';
import { Badge, StatusBadge, TONE_CLASSES, toneOf } from '@/components/ui/badge';
import { DataTable } from '@/components/data-table';
import { ConfirmDialog } from '@/components/confirm-dialog';

describe('StatusBadge', () => {
  it('has a style for every shared status tone', () => {
    for (const t of STATUS_TONES) expect(TONE_CLASSES[t]).toBeTruthy();
  });
  it('maps platform statuses to tones and labels', () => {
    render(
      <>
        <StatusBadge status="ACTIVE" />
        <StatusBadge status="LOCKED" />
        <StatusBadge status="PENDING_ACTIVATION" />
        <StatusBadge status="CUSTOM_KEY" label="Custom" tone="accent" />
      </>,
    );
    expect(screen.getByText('Active').closest('[data-tone]')).toHaveAttribute('data-tone', 'success');
    expect(screen.getByText('Locked').closest('[data-tone]')).toHaveAttribute('data-tone', 'danger');
    expect(screen.getByText('Pending activation').closest('[data-tone]')).toHaveAttribute('data-tone', 'warning');
    expect(screen.getByText('Custom').closest('[data-tone]')).toHaveAttribute('data-tone', 'accent');
  });
  it('falls back to neutral for unknown tones', () => {
    expect(toneOf('purple')).toBe('neutral');
    render(<Badge tone={toneOf('info')}>x</Badge>);
    expect(screen.getByText('x').className).toContain('sky');
  });
});

describe('DataTable', () => {
  const columns = [{ key: 'name', header: 'Name', cell: (r: { id: string; name: string }) => r.name }];

  it('shows skeleton rows while loading', () => {
    render(<DataTable columns={columns} rows={undefined} rowKey={(r) => r.id} loading />);
    expect(screen.getAllByTestId('skeleton-row')).toHaveLength(5);
  });

  it('shows the empty state when there are no rows', () => {
    render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} emptyTitle="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('shows an error with retry', async () => {
    const retry = vi.fn();
    render(<DataTable columns={columns} rows={undefined} rowKey={(r) => r.id} error={new Error('boom')} onRetry={retry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(retry).toHaveBeenCalled();
  });

  it('renders rows and toggles sort', async () => {
    const onSort = vi.fn();
    render(
      <DataTable
        columns={[{ ...columns[0]!, sortKey: 'name' }]}
        rows={[{ id: '1', name: 'Alpha' }]}
        rowKey={(r) => r.id}
        sort="name"
        onSortChange={onSort}
      />,
    );
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /name/i }));
    expect(onSort).toHaveBeenCalledWith('-name');
  });
});

describe('ConfirmDialog', () => {
  it('requires a reason when configured', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open onOpenChange={() => {}} title="Deactivate?" reason="required" confirmLabel="Deactivate" onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('A reason is required');

    await userEvent.type(screen.getByLabelText(/reason/i), 'No longer employed');
    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(onConfirm).toHaveBeenCalledWith('No longer employed');
  });

  it('confirms without a reason when not configured', async () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(<ConfirmDialog open onOpenChange={onOpenChange} title="Unlock?" confirmLabel="Unlock" onConfirm={onConfirm} />);
    expect(screen.queryByLabelText(/reason/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(onConfirm).toHaveBeenCalledWith('');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('stays open when the action fails', async () => {
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Do it?"
        confirmLabel="Go"
        onConfirm={() => {
          throw new Error('nope');
        }}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

import { forwardRef } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuGroup = Menu.Group;

export const DropdownMenuContent = forwardRef<HTMLDivElement, Menu.DropdownMenuContentProps>(
  ({ className, sideOffset = 6, align = 'end', ...props }, ref) => (
    <Menu.Portal>
      <Menu.Content
        ref={ref}
        sideOffset={sideOffset}
        align={align}
        className={cn('z-50 min-w-[12rem] overflow-hidden rounded-lg border border-border bg-white p-1 shadow-lg animate-fade-in', className)}
        {...props}
      />
    </Menu.Portal>
  ),
);
DropdownMenuContent.displayName = 'DropdownMenuContent';

export const DropdownMenuItem = forwardRef<HTMLDivElement, Menu.DropdownMenuItemProps>(({ className, ...props }, ref) => (
  <Menu.Item
    ref={ref}
    className={cn(
      'flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-2 text-sm text-slate-700 outline-none data-[highlighted]:bg-slate-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = 'DropdownMenuItem';

export const DropdownMenuLabel = ({ className, ...props }: Menu.DropdownMenuLabelProps) => (
  <Menu.Label className={cn('px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500', className)} {...props} />
);
export const DropdownMenuSeparator = () => <Menu.Separator className="my-1 h-px bg-border" />;

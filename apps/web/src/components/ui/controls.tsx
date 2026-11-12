import { forwardRef } from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Checkbox = forwardRef<HTMLButtonElement, CheckboxPrimitive.CheckboxProps>(({ className, checked, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    checked={checked}
    className={cn(
      'peer h-4 w-4 shrink-0 rounded border border-slate-400 bg-white data-[state=checked]:border-royal-700 data-[state=checked]:bg-royal-700 data-[state=indeterminate]:border-royal-700 data-[state=indeterminate]:bg-royal-700 disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-white">
      {checked === 'indeterminate' ? <Minus className="h-3 w-3" /> : <Check className="h-3 w-3" />}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = 'Checkbox';

export const Switch = forwardRef<HTMLButtonElement, SwitchPrimitive.SwitchProps>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent bg-slate-300 transition-colors data-[state=checked]:bg-teal-600 disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="pointer-events-none block h-5 w-5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0" />
  </SwitchPrimitive.Root>
));
Switch.displayName = 'Switch';

export const Tabs = TabsPrimitive.Root;
export const TabsList = forwardRef<HTMLDivElement, TabsPrimitive.TabsListProps>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn('flex max-w-full gap-1 overflow-x-auto border-b border-border', className)}
    {...props}
  />
));
TabsList.displayName = 'TabsList';
export const TabsTrigger = forwardRef<HTMLButtonElement, TabsPrimitive.TabsTriggerProps>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      '-mb-px whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-600 hover:text-navy-900 data-[state=active]:border-royal-700 data-[state=active]:text-royal-700',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = 'TabsTrigger';
export const TabsContent = forwardRef<HTMLDivElement, TabsPrimitive.TabsContentProps>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn('pt-4 focus-visible:outline-none', className)} {...props} />
));
TabsContent.displayName = 'TabsContent';

export const TooltipProvider = TooltipPrimitive.Provider;
export function Tooltip({ content, children }: { content: string; children: React.ReactNode }) {
  return (
    <TooltipPrimitive.Root delayDuration={300}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          sideOffset={6}
          className="z-50 rounded-md bg-navy-900 px-2 py-1 text-xs text-white shadow-lg animate-fade-in"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

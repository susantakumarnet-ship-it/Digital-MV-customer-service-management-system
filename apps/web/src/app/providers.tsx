import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/controls';
import { AuthProvider, useAuth } from '@/features/auth/auth-context';
import { parseApiError } from '@/lib/api';
import { configureDisplay } from '@/lib/format';
import { usePublicSettings } from '@/lib/queries';

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 20_000,
        refetchOnWindowFocus: false,
        // Don't retry client errors (403/404/validation); retry transient failures twice.
        retry: (count, err) => {
          const status = parseApiError(err).status ?? 0;
          return status >= 500 || status === 0 ? count < 2 : false;
        },
      },
      mutations: { retry: false },
    },
  });
}

/** Applies configured timezone/date format, preferring the user's own timezone (UI-08). */
function DisplaySettings({ children }: { children: ReactNode }) {
  const settings = usePublicSettings();
  const { user } = useAuth();
  const [, force] = useState(0);
  useEffect(() => {
    configureDisplay({ timezone: user?.timezone || settings.data?.timezone, dateFormat: settings.data?.dateFormat });
    force((n) => n + 1);
  }, [settings.data, user?.timezone]);
  return <>{children}</>;
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [client] = useState(makeClient);
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <AuthProvider>
          <DisplaySettings>{children}</DisplaySettings>
        </AuthProvider>
      </TooltipProvider>
      <Toaster position="top-right" richColors closeButton />
    </QueryClientProvider>
  );
}

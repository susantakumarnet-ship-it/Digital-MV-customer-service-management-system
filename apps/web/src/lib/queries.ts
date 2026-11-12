import { useQuery } from '@tanstack/react-query';
import type { MasterKey } from '@mv/shared';
import { api } from './api';
import type { MasterOption, PublicSettings, RoleDto } from './types';

export function usePublicSettings() {
  return useQuery({
    queryKey: ['settings', 'public'],
    queryFn: async () => (await api.get<PublicSettings>('/settings/public')).data,
    staleTime: 5 * 60_000,
  });
}

export function useMasterOptions(resource: MasterKey | undefined, opts?: { parentField?: string; parentId?: string; enabled?: boolean; includeInactive?: boolean }) {
  return useQuery({
    queryKey: ['masters', resource, 'options', opts?.parentField ?? null, opts?.parentId ?? null, opts?.includeInactive ?? false],
    queryFn: async () =>
      (
        await api.get<MasterOption[]>(`/masters/${resource}/options`, {
          params: {
            parentField: opts?.parentId ? opts?.parentField : undefined,
            parentId: opts?.parentId || undefined,
            includeInactive: opts?.includeInactive || undefined,
          },
        })
      ).data,
    enabled: Boolean(resource) && (opts?.enabled ?? true),
    staleTime: 60_000,
  });
}

export function useRoles(includeInactive = false, enabled = true) {
  return useQuery({
    queryKey: ['roles', { includeInactive }],
    queryFn: async () => (await api.get<RoleDto[]>('/roles', { params: { includeInactive: includeInactive || undefined } })).data,
    enabled,
  });
}

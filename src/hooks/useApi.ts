import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api-client';
import { apiKey } from '../lib/query';

export interface UseApiResult<T> {
  data: T | null;
  error: string | null;
  /** True on the first load only; refetches keep showing the previous data. */
  loading: boolean;
  /** Fetch again (after a change on this page) */
  reload: () => Promise<void>;
}

/**
 * GET `path` and track loading/error state, cached and shared through
 * TanStack Query (lib/query.ts). Refetches when `path` changes, showing the
 * previous data until the new arrives; pass `null` to skip.
 */
export function useApi<T>(path: string | null): UseApiResult<T> {
  const query = useQuery({
    queryKey: apiKey(path ?? ''),
    queryFn: () => apiGet<T>(path!),
    enabled: path !== null,
    placeholderData: keepPreviousData,
  });
  return {
    data: query.data ?? null,
    error: query.error ? (query.error instanceof Error ? query.error.message : 'Request failed') : null,
    loading: path !== null && query.isPending,
    reload: async () => {
      await query.refetch();
    },
  };
}

/**
 * Server data on the page (TanStack Query). Every GET through useApi() is
 * cached under ['api', path], so pages that ask for the same thing share one
 * request, and coming back to a page shows what it had at once while it
 * checks for changes.
 *
 * The cache belongs to one person in one organization: it's emptied when
 * someone signs in or out or the session ends (contexts/AuthContext.tsx), and
 * the organization platform staff are working in through a support session
 * is part of every key, so nothing from one shows in another.
 */
import { QueryClient, type QueryKey } from '@tanstack/react-query';
import { ApiError, actingTenant } from './api-client';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Shown at once when a page opens again, and always checked for changes
      // then: pages don't yet say what each change affects (invalidateApi)
      staleTime: 0,
      // Refetching on focus would count as activity for the idle timeout
      // (backend lib/sign-in.ts) and surprise people mid-edit
      refetchOnWindowFocus: false,
      // Once, for a dropped connection or a server error; never for a refusal
      retry: (failures, error) => failures < 1 && !(error instanceof ApiError && error.status < 500),
    },
  },
});

/** The cache key for a GET of `path` */
export const apiKey = (path: string): QueryKey => ['api', actingTenant(), path];

/**
 * After a change: refetch every cached GET whose path starts with one of
 * these (e.g. '/users' covers '/users?page=2' and '/users/123')
 */
export function invalidateApi(...prefixes: string[]): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (q) => q.queryKey[0] === 'api' && prefixes.some((p) => String(q.queryKey[2]).startsWith(p)),
  });
}

/** Forget everything cached (another person, organization or session) */
export function clearApiCache(): void {
  queryClient.clear();
}

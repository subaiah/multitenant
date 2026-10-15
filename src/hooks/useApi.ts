import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet } from '../lib/api-client';

interface UseApiResult<T> {
  data: T | null;
  error: string | null;
  /** True on the first load only; refetches keep showing the previous data. */
  loading: boolean;
  reload: () => Promise<void>;
}

/**
 * GET `path` and track loading/error state. Refetches when `path` changes;
 * pass `null` to skip. Stale responses from an earlier `path` are ignored.
 */
export function useApi<T>(path: string | null): UseApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const latest = useRef(path);

  const load = useCallback(async () => {
    if (path === null) return;
    latest.current = path;
    setError(null);
    try {
      const result = await apiGet<T>(path);
      if (latest.current === path) setData(result);
    } catch (err) {
      if (latest.current === path) setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      if (latest.current === path) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, error, loading, reload: load };
}

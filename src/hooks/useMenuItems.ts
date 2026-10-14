import { useState, useEffect } from 'react';
import { apiGet } from '../lib/api-client';

export interface MenuItem {
  id: string;
  portal: 'PLATFORM' | 'TENANT';
  parentId: string | null;
  label: string;
  path: string;
  icon: string | null;
  permission: string | null;
  order: number;
  isActive: boolean;
  children?: MenuItem[];
}

export function useMenuItems(portal: 'PLATFORM' | 'TENANT') {
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchMenuItems = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await apiGet<{ menuItems: MenuItem[] }>(`/menu-items/portal/${portal}`);
        setMenuItems(response.menuItems);
      } catch (err) {
        console.error('Failed to fetch menu items:', err);
        setError(err instanceof Error ? err.message : 'Failed to fetch menu items');
      } finally {
        setLoading(false);
      }
    };

    fetchMenuItems();
  }, [portal]);

  return { menuItems, loading, error };
}

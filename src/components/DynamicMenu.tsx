/**
 * The sidebar menu, from the menu entries the server allows this person
 * (src/kit/menu-definitions.ts on the server). A top-level entry whose path
 * starts with "#" is a section: its label heads the entries inside it.
 */
import { Link, useLocation } from 'react-router-dom';
import { useMemo } from 'react';
import {
  Activity, Boxes, Building2, ClipboardCheck, Code, CreditCard, Database, KeyRound, KeySquare, LayoutDashboard, LifeBuoy,
  Network, Package, ScrollText, Server, Settings, Shield, ShieldCheck, Users, UsersRound, type LucideIcon,
} from 'lucide-react';
import { useMenuItems, type MenuItem } from '../hooks/useMenuItems';
import { useAuth } from '../contexts/AuthContext';

const ICONS: Record<string, LucideIcon> = {
  Activity, Boxes, Building2, ClipboardCheck, Code, CreditCard, Database, KeyRound, KeySquare, LayoutDashboard, LifeBuoy,
  Network, Package, ScrollText, Server, Settings, Shield, ShieldCheck, Users, UsersRound,
};

const isSection = (item: MenuItem) => item.path.startsWith('#');

export default function DynamicMenu({ portal, onNavigate }: { portal: 'PLATFORM' | 'TENANT'; onNavigate?: () => void }) {
  const { menuItems, loading, error } = useMenuItems(portal);
  // The server already filtered the menu; a page shows if its permission applies anywhere
  const { hasPermissionAnywhere: hasPermission, loading: permLoading } = useAuth();
  const { pathname } = useLocation();

  const items = useMemo(() => {
    if (loading || permLoading) return [];
    const allowed = (i: MenuItem) => !i.permission || hasPermission(i.permission);
    return menuItems
      .filter(allowed)
      .map((i) => ({ ...i, children: (i.children ?? []).filter(allowed) }))
      // A section with nothing left in it disappears
      .filter((i) => !isSection(i) || i.children.length > 0);
  }, [menuItems, hasPermission, loading, permLoading]);

  // The longest matching path wins, so /roles/new doesn't also light up /roles
  const current = useMemo(() => {
    const paths = items.flatMap((i) => (isSection(i) ? i.children.map((c) => c.path) : [i.path, ...i.children.map((c) => c.path)]));
    return paths
      .filter((p) => pathname === p || pathname.startsWith(p + '/'))
      .sort((a, b) => b.length - a.length)[0];
  }, [items, pathname]);

  if (loading || permLoading) {
    return (
      <div className="px-3 space-y-2" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-8 rounded-md bg-sidebar-raised/60" />)}
      </div>
    );
  }
  if (error) return <p className="px-4 text-sm text-red-300" role="alert">The menu couldn't be loaded. Reload the page to try again.</p>;

  const link = (item: MenuItem) => {
    const Icon = (item.icon && ICONS[item.icon]) || LayoutDashboard;
    const active = item.path === current;
    return (
      <Link
        key={item.id}
        to={item.path}
        onClick={onNavigate}
        aria-current={active ? 'page' : undefined}
        className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
          active ? 'bg-sidebar-raised text-white font-medium' : 'text-sidebar-ink hover:bg-sidebar-raised/60 hover:text-white'
        }`}
      >
        <Icon size={18} strokeWidth={1.75} aria-hidden className={active ? 'text-sidebar-accent' : 'text-sidebar-muted'} />
        <span className="truncate">{item.label}</span>
      </Link>
    );
  };

  return (
    <nav aria-label="Main" className="px-3 flex flex-col gap-5">
      {items.map((item) =>
        isSection(item) ? (
          <div key={item.id} className="flex flex-col gap-0.5">
            <p className="px-3 pb-1.5 text-xs text-sidebar-muted">{item.label}</p>
            {item.children.map(link)}
          </div>
        ) : (
          <div key={item.id} className="flex flex-col gap-0.5">
            {link(item)}
            {item.children.map(link)}
          </div>
        ),
      )}
    </nav>
  );
}

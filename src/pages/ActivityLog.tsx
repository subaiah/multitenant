import { useState } from 'react';
import { Search, Filter, Activity, Rocket, Settings, Users, DollarSign, AlertTriangle, RefreshCw } from 'lucide-react';
import { activities, tenants } from '../data/mockData';

export default function ActivityLog() {
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [tenantFilter, setTenantFilter] = useState<string>('all');

  const filteredActivities = activities.filter((activity) => {
    const matchesSearch =
      activity.user.toLowerCase().includes(searchQuery.toLowerCase()) ||
      activity.target.toLowerCase().includes(searchQuery.toLowerCase()) ||
      activity.action.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesType = typeFilter === 'all' || activity.type === typeFilter;
    const matchesTenant = tenantFilter === 'all' || activity.tenantId === tenantFilter;
    return matchesSearch && matchesType && matchesTenant;
  });

  const getTenantName = (tenantId: string) => {
    return tenants.find((t) => t.id === tenantId)?.name || 'Unknown';
  };

  const typeConfig: Record<string, { icon: React.ElementType; color: string; label: string }> = {
    deploy: { icon: Rocket, color: 'bg-blue-100 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400', label: 'Deploy' },
    config: { icon: Settings, color: 'bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400', label: 'Config' },
    user: { icon: Users, color: 'bg-green-100 text-green-600 dark:bg-green-500/20 dark:text-green-400', label: 'User' },
    billing: { icon: DollarSign, color: 'bg-purple-100 text-purple-600 dark:bg-purple-500/20 dark:text-purple-400', label: 'Billing' },
    alert: { icon: AlertTriangle, color: 'bg-red-100 text-red-600 dark:bg-red-500/20 dark:text-red-400', label: 'Alert' },
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-800 dark:text-white">Activity Log</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Track all actions across tenants and applications
          </p>
        </div>
        <button className="flex items-center gap-2 px-4 py-2.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 text-sm font-medium rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors">
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search activities..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-slate-700 dark:text-slate-200 placeholder-slate-400"
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="px-4 py-2.5 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200"
        >
          <option value="all">All Types</option>
          <option value="deploy">Deploy</option>
          <option value="config">Config</option>
          <option value="user">User</option>
          <option value="billing">Billing</option>
          <option value="alert">Alert</option>
        </select>
        <select
          value={tenantFilter}
          onChange={(e) => setTenantFilter(e.target.value)}
          className="px-4 py-2.5 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200"
        >
          <option value="all">All Tenants</option>
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>

      {/* Activity Timeline */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700">
        <div className="divide-y divide-slate-100 dark:divide-slate-700">
          {filteredActivities.map((activity, index) => {
            const config = typeConfig[activity.type];
            const Icon = config.icon;
            return (
              <div
                key={activity.id}
                className="flex items-start gap-4 p-5 hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors"
              >
                {/* Timeline dot */}
                <div className="flex flex-col items-center">
                  <div className={`p-2 rounded-lg ${config.color}`}>
                    <Icon size={16} />
                  </div>
                  {index < filteredActivities.length - 1 && (
                    <div className="w-px h-full min-h-[20px] bg-slate-200 dark:bg-slate-700 mt-2"></div>
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm text-slate-700 dark:text-slate-200">
                        <span className="font-semibold">{activity.user}</span>{' '}
                        <span>{activity.action}</span>{' '}
                        <span className="font-semibold">{activity.target}</span>
                      </p>
                      <div className="flex items-center gap-3 mt-1.5">
                        <span className="text-xs text-slate-400">{activity.timestamp}</span>
                        <span className="text-xs text-slate-400">•</span>
                        <span className="text-xs text-slate-400">{getTenantName(activity.tenantId)}</span>
                      </div>
                    </div>
                    <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${config.color}`}>
                      {config.label}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {filteredActivities.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-slate-400">
            <Activity size={40} className="mb-3 opacity-50" />
            <p className="text-sm">No activities found</p>
            <p className="text-xs mt-1">Try adjusting your filters</p>
          </div>
        )}
      </div>
    </div>
  );
}

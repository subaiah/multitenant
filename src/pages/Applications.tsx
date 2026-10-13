import { useState } from 'react';
import {
  Search,
  Plus,
  MoreVertical,
  Play,
  Pause,
  RotateCw,
  Trash2,
  ExternalLink,
  Cpu,
  MemoryStick,
  Activity,
  Clock,
  Globe,
  Server,
} from 'lucide-react';
import { applications, tenants, type Application } from '../data/mockData';

export default function Applications() {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [envFilter, setEnvFilter] = useState<string>('all');
  const [tenantFilter, setTenantFilter] = useState<string>('all');
  const [selectedApp, setSelectedApp] = useState<Application | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');

  const filteredApps = applications.filter((app) => {
    const matchesSearch =
      app.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      app.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || app.status === statusFilter;
    const matchesEnv = envFilter === 'all' || app.environment === envFilter;
    const matchesTenant = tenantFilter === 'all' || app.tenantId === tenantFilter;
    return matchesSearch && matchesStatus && matchesEnv && matchesTenant;
  });

  const getTenantName = (tenantId: string) => {
    return tenants.find((t) => t.id === tenantId)?.name || 'Unknown';
  };

  const statusColors: Record<string, { bg: string; text: string; dot: string }> = {
    running: { bg: 'bg-green-100 dark:bg-green-500/20', text: 'text-green-700 dark:text-green-400', dot: 'bg-green-500' },
    stopped: { bg: 'bg-slate-100 dark:bg-slate-600', text: 'text-slate-700 dark:text-slate-300', dot: 'bg-slate-400' },
    deploying: { bg: 'bg-blue-100 dark:bg-blue-500/20', text: 'text-blue-700 dark:text-blue-400', dot: 'bg-blue-500' },
    error: { bg: 'bg-red-100 dark:bg-red-500/20', text: 'text-red-700 dark:text-red-400', dot: 'bg-red-500' },
  };

  const envColors: Record<string, string> = {
    production: 'bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400',
    staging: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400',
    development: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400',
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-800 dark:text-white">Applications</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Monitor and manage all tenant applications
          </p>
        </div>
        <button className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors shadow-sm">
          <Plus size={16} />
          Deploy New App
        </button>
      </div>

      {/* Status Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-100 dark:bg-green-500/20">
              <Play size={16} className="text-green-600 dark:text-green-400" />
            </div>
            <div>
              <p className="text-xl font-bold text-slate-800 dark:text-white">
                {applications.filter((a) => a.status === 'running').length}
              </p>
              <p className="text-xs text-slate-500">Running</p>
            </div>
          </div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-500/20">
              <RotateCw size={16} className="text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <p className="text-xl font-bold text-slate-800 dark:text-white">
                {applications.filter((a) => a.status === 'deploying').length}
              </p>
              <p className="text-xs text-slate-500">Deploying</p>
            </div>
          </div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-slate-100 dark:bg-slate-600">
              <Pause size={16} className="text-slate-600 dark:text-slate-300" />
            </div>
            <div>
              <p className="text-xl font-bold text-slate-800 dark:text-white">
                {applications.filter((a) => a.status === 'stopped').length}
              </p>
              <p className="text-xs text-slate-500">Stopped</p>
            </div>
          </div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-red-100 dark:bg-red-500/20">
              <Activity size={16} className="text-red-600 dark:text-red-400" />
            </div>
            <div>
              <p className="text-xl font-bold text-slate-800 dark:text-white">
                {applications.filter((a) => a.status === 'error').length}
              </p>
              <p className="text-xs text-slate-500">Errors</p>
            </div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search applications..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-slate-700 dark:text-slate-200 placeholder-slate-400"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-4 py-2.5 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200"
        >
          <option value="all">All Status</option>
          <option value="running">Running</option>
          <option value="stopped">Stopped</option>
          <option value="deploying">Deploying</option>
          <option value="error">Error</option>
        </select>
        <select
          value={envFilter}
          onChange={(e) => setEnvFilter(e.target.value)}
          className="px-4 py-2.5 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200"
        >
          <option value="all">All Environments</option>
          <option value="production">Production</option>
          <option value="staging">Staging</option>
          <option value="development">Development</option>
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

        {/* View toggle */}
        <div className="flex items-center bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
          <button
            onClick={() => setViewMode('grid')}
            className={`px-3 py-2.5 text-sm ${
              viewMode === 'grid'
                ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-600'
                : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-700'
            }`}
          >
            Grid
          </button>
          <button
            onClick={() => setViewMode('table')}
            className={`px-3 py-2.5 text-sm ${
              viewMode === 'table'
                ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-600'
                : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-700'
            }`}
          >
            Table
          </button>
        </div>
      </div>

      {/* Grid View */}
      {viewMode === 'grid' && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredApps.map((app) => {
            const status = statusColors[app.status];
            return (
              <div
                key={app.id}
                onClick={() => setSelectedApp(app)}
                className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-5 hover:shadow-lg hover:border-blue-200 dark:hover:border-blue-800 transition-all cursor-pointer group"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-slate-800 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                        {app.name}
                      </h3>
                      <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${status.bg} ${status.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${status.dot} ${app.status === 'deploying' ? 'animate-pulse' : ''}`}></span>
                        {app.status}
                      </span>
                    </div>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 line-clamp-1">
                      {app.description}
                    </p>
                  </div>
                  <button
                    onClick={(e) => e.stopPropagation()}
                    className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400"
                  >
                    <MoreVertical size={16} />
                  </button>
                </div>

                <div className="mt-3 flex items-center gap-2">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${envColors[app.environment]}`}>
                    {app.environment}
                  </span>
                  <span className="text-xs text-slate-400">v{app.version}</span>
                </div>

                <div className="mt-4 flex items-center gap-1 text-xs text-slate-400">
                  <Globe size={12} />
                  <span className="truncate">{app.url}</span>
                </div>

                {/* Resource bars */}
                <div className="mt-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <Cpu size={12} className="text-slate-400" />
                    <div className="flex-1 h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          app.cpu > 80 ? 'bg-red-500' : app.cpu > 50 ? 'bg-amber-500' : 'bg-green-500'
                        }`}
                        style={{ width: `${app.cpu}%` }}
                      ></div>
                    </div>
                    <span className="text-xs text-slate-500 w-8 text-right">{app.cpu}%</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <MemoryStick size={12} className="text-slate-400" />
                    <div className="flex-1 h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          app.memory > 80 ? 'bg-red-500' : app.memory > 50 ? 'bg-amber-500' : 'bg-green-500'
                        }`}
                        style={{ width: `${app.memory}%` }}
                      ></div>
                    </div>
                    <span className="text-xs text-slate-500 w-8 text-right">{app.memory}%</span>
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-700 flex items-center justify-between">
                  <span className="text-xs text-slate-400">
                    {getTenantName(app.tenantId)}
                  </span>
                  <span className="text-xs text-slate-400 flex items-center gap-1">
                    <Clock size={10} />
                    {app.lastDeployed}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Table View */}
      {viewMode === 'table' && (
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                    Application
                  </th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                    Tenant
                  </th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                    Environment
                  </th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                    CPU
                  </th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                    Memory
                  </th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                    Requests
                  </th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredApps.map((app) => {
                  const status = statusColors[app.status];
                  return (
                    <tr
                      key={app.id}
                      className="border-b border-slate-50 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors cursor-pointer"
                      onClick={() => setSelectedApp(app)}
                    >
                      <td className="px-5 py-3.5">
                        <div>
                          <p className="text-sm font-medium text-slate-800 dark:text-white">{app.name}</p>
                          <p className="text-xs text-slate-400">v{app.version}</p>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-sm text-slate-600 dark:text-slate-300">
                        {getTenantName(app.tenantId)}
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${status.bg} ${status.text}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`}></span>
                          {app.status}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${envColors[app.environment]}`}>
                          {app.environment}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${
                                app.cpu > 80 ? 'bg-red-500' : app.cpu > 50 ? 'bg-amber-500' : 'bg-green-500'
                              }`}
                              style={{ width: `${app.cpu}%` }}
                            ></div>
                          </div>
                          <span className="text-xs text-slate-500">{app.cpu}%</span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${
                                app.memory > 80 ? 'bg-red-500' : app.memory > 50 ? 'bg-amber-500' : 'bg-green-500'
                              }`}
                              style={{ width: `${app.memory}%` }}
                            ></div>
                          </div>
                          <span className="text-xs text-slate-500">{app.memory}%</span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-sm text-slate-600 dark:text-slate-300">
                        {app.requests.toLocaleString()}
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={(e) => e.stopPropagation()}
                            className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-green-500"
                          >
                            <Play size={14} />
                          </button>
                          <button
                            onClick={(e) => e.stopPropagation()}
                            className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-amber-500"
                          >
                            <RotateCw size={14} />
                          </button>
                          <button
                            onClick={(e) => e.stopPropagation()}
                            className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-red-500"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* App Detail Modal */}
      {selectedApp && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto">
            <div className="p-6 border-b border-slate-200 dark:border-slate-700">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center text-white">
                    <Server size={22} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-xl font-bold text-slate-800 dark:text-white">
                        {selectedApp.name}
                      </h3>
                      <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${statusColors[selectedApp.status].bg} ${statusColors[selectedApp.status].text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${statusColors[selectedApp.status].dot}`}></span>
                        {selectedApp.status}
                      </span>
                    </div>
                    <p className="text-sm text-slate-400">{selectedApp.description}</p>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedApp(null)}
                  className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="p-6 space-y-6">
              {/* Resource Usage */}
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-slate-50 dark:bg-slate-700/50 rounded-xl p-4 text-center">
                  <Cpu size={20} className="mx-auto text-blue-500 mb-2" />
                  <p className="text-xl font-bold text-slate-800 dark:text-white">{selectedApp.cpu}%</p>
                  <p className="text-xs text-slate-500">CPU Usage</p>
                </div>
                <div className="bg-slate-50 dark:bg-slate-700/50 rounded-xl p-4 text-center">
                  <MemoryStick size={20} className="mx-auto text-purple-500 mb-2" />
                  <p className="text-xl font-bold text-slate-800 dark:text-white">{selectedApp.memory}%</p>
                  <p className="text-xs text-slate-500">Memory</p>
                </div>
                <div className="bg-slate-50 dark:bg-slate-700/50 rounded-xl p-4 text-center">
                  <Activity size={20} className="mx-auto text-green-500 mb-2" />
                  <p className="text-xl font-bold text-slate-800 dark:text-white">{selectedApp.requests.toLocaleString()}</p>
                  <p className="text-xs text-slate-500">Requests</p>
                </div>
              </div>

              {/* Details */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-slate-800 dark:text-white">Application Details</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-slate-400">Version</p>
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-200">v{selectedApp.version}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Environment</p>
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-200 capitalize">{selectedApp.environment}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">URL</p>
                    <p className="text-sm font-medium text-blue-600 dark:text-blue-400 flex items-center gap-1">
                      {selectedApp.url}
                      <ExternalLink size={12} />
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Tenant</p>
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{getTenantName(selectedApp.tenantId)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Last Deployed</p>
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{selectedApp.lastDeployed}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Created</p>
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{selectedApp.createdAt}</p>
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-3 pt-4 border-t border-slate-200 dark:border-slate-700">
                <button className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition-colors">
                  <Play size={14} />
                  Restart
                </button>
                <button className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
                  <RotateCw size={14} />
                  Redeploy
                </button>
                <button className="flex items-center justify-center gap-2 px-4 py-2.5 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200 text-sm font-medium rounded-lg hover:bg-slate-50 dark:hover:bg-slate-600 transition-colors">
                  <ExternalLink size={14} />
                  Open
                </button>
                <button className="px-4 py-2.5 bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 text-sm font-medium rounded-lg hover:bg-red-100 dark:hover:bg-red-500/20 transition-colors">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

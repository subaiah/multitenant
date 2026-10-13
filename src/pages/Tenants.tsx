import { useState } from 'react';
import {
  Search,
  Filter,
  Plus,
  MoreVertical,
  Building2,
  Users,
  AppWindow,
  HardDrive,
  Calendar,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { tenants, type Tenant } from '../data/mockData';

export default function Tenants() {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [planFilter, setPlanFilter] = useState<string>('all');
  const [selectedTenant, setSelectedTenant] = useState<Tenant | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  const filteredTenants = tenants.filter((tenant) => {
    const matchesSearch =
      tenant.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      tenant.slug.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'all' || tenant.status === statusFilter;
    const matchesPlan = planFilter === 'all' || tenant.plan === planFilter;
    return matchesSearch && matchesStatus && matchesPlan;
  });

  const statusCounts = {
    all: tenants.length,
    active: tenants.filter((t) => t.status === 'active').length,
    trial: tenants.filter((t) => t.status === 'trial').length,
    suspended: tenants.filter((t) => t.status === 'suspended').length,
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-800 dark:text-white">Tenant Management</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Manage all tenants and their configurations
          </p>
        </div>
        <button className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors shadow-sm">
          <Plus size={16} />
          Add Tenant
        </button>
      </div>

      {/* Status Tabs */}
      <div className="flex gap-1 bg-white dark:bg-slate-800 p-1 rounded-xl border border-slate-200 dark:border-slate-700 w-fit">
        {Object.entries(statusCounts).map(([status, count]) => (
          <button
            key={status}
            onClick={() => setStatusFilter(status)}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
              statusFilter === status
                ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400'
                : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700'
            }`}
          >
            {status.charAt(0).toUpperCase() + status.slice(1)}
            <span className="ml-2 text-xs bg-slate-100 dark:bg-slate-700 px-1.5 py-0.5 rounded-full">
              {count}
            </span>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search tenants..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-slate-700 dark:text-slate-200 placeholder-slate-400"
          />
        </div>
        <select
          value={planFilter}
          onChange={(e) => setPlanFilter(e.target.value)}
          className="px-4 py-2.5 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200"
        >
          <option value="all">All Plans</option>
          <option value="enterprise">Enterprise</option>
          <option value="professional">Professional</option>
          <option value="starter">Starter</option>
          <option value="free">Free</option>
        </select>
        <button className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors">
          <Filter size={16} />
          More Filters
        </button>
      </div>

      {/* Tenant Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filteredTenants.map((tenant) => (
          <div
            key={tenant.id}
            onClick={() => setSelectedTenant(tenant)}
            className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-5 hover:shadow-lg hover:border-blue-200 dark:hover:border-blue-800 transition-all cursor-pointer group"
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white font-bold text-lg shadow-sm">
                  {tenant.name.charAt(0)}
                </div>
                <div>
                  <h3 className="font-semibold text-slate-800 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                    {tenant.name}
                  </h3>
                  <p className="text-xs text-slate-400">{tenant.slug}</p>
                </div>
              </div>
              <button className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400">
                <MoreVertical size={16} />
              </button>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <span
                className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                  tenant.plan === 'enterprise'
                    ? 'bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-400'
                    : tenant.plan === 'professional'
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400'
                    : tenant.plan === 'starter'
                    ? 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400'
                    : 'bg-slate-100 text-slate-700 dark:bg-slate-600 dark:text-slate-300'
                }`}
              >
                {tenant.plan}
              </span>
              <span
                className={`inline-flex items-center gap-1 text-xs font-medium ${
                  tenant.status === 'active'
                    ? 'text-green-600 dark:text-green-400'
                    : tenant.status === 'trial'
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-red-600 dark:text-red-400'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    tenant.status === 'active'
                      ? 'bg-green-500'
                      : tenant.status === 'trial'
                      ? 'bg-amber-500'
                      : 'bg-red-500'
                  }`}
                ></span>
                {tenant.status}
              </span>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-3">
              <div className="flex items-center gap-2">
                <Users size={14} className="text-slate-400" />
                <span className="text-sm text-slate-600 dark:text-slate-300">{tenant.users}</span>
              </div>
              <div className="flex items-center gap-2">
                <AppWindow size={14} className="text-slate-400" />
                <span className="text-sm text-slate-600 dark:text-slate-300">{tenant.apps}</span>
              </div>
              <div className="flex items-center gap-2">
                <HardDrive size={14} className="text-slate-400" />
                <span className="text-sm text-slate-600 dark:text-slate-300">{tenant.storage}</span>
              </div>
            </div>

            <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-700 flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs text-slate-400">
                <Calendar size={12} />
                Created {tenant.createdAt}
              </div>
              <span className="text-xs text-slate-400">Active {tenant.lastActive}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Showing <span className="font-medium">{filteredTenants.length}</span> of{' '}
          <span className="font-medium">{tenants.length}</span> tenants
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
            disabled={currentPage === 1}
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={16} />
          </button>
          <button className="px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-lg">
            1
          </button>
          <button className="px-3 py-1.5 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg">
            2
          </button>
          <button
            onClick={() => setCurrentPage(currentPage + 1)}
            disabled={currentPage >= 2}
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* Tenant Detail Modal */}
      {selectedTenant && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-y-auto">
            <div className="p-6 border-b border-slate-200 dark:border-slate-700">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white font-bold text-xl">
                    {selectedTenant.name.charAt(0)}
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-slate-800 dark:text-white">
                      {selectedTenant.name}
                    </h3>
                    <p className="text-sm text-slate-400">{selectedTenant.slug}</p>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedTenant(null)}
                  className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400"
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="p-6 space-y-6">
              {/* Stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-slate-50 dark:bg-slate-700/50 rounded-xl p-4 text-center">
                  <Users size={20} className="mx-auto text-blue-500 mb-2" />
                  <p className="text-xl font-bold text-slate-800 dark:text-white">{selectedTenant.users}</p>
                  <p className="text-xs text-slate-500">Users</p>
                </div>
                <div className="bg-slate-50 dark:bg-slate-700/50 rounded-xl p-4 text-center">
                  <AppWindow size={20} className="mx-auto text-green-500 mb-2" />
                  <p className="text-xl font-bold text-slate-800 dark:text-white">{selectedTenant.apps}</p>
                  <p className="text-xs text-slate-500">Applications</p>
                </div>
                <div className="bg-slate-50 dark:bg-slate-700/50 rounded-xl p-4 text-center">
                  <HardDrive size={20} className="mx-auto text-purple-500 mb-2" />
                  <p className="text-xl font-bold text-slate-800 dark:text-white">{selectedTenant.storage}</p>
                  <p className="text-xs text-slate-500">Storage</p>
                </div>
                <div className="bg-slate-50 dark:bg-slate-700/50 rounded-xl p-4 text-center">
                  <Building2 size={20} className="mx-auto text-amber-500 mb-2" />
                  <p className="text-xl font-bold text-slate-800 dark:text-white capitalize">{selectedTenant.plan}</p>
                  <p className="text-xs text-slate-500">Plan</p>
                </div>
              </div>

              {/* Details */}
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-slate-800 dark:text-white">Details</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-slate-400">Status</p>
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-200 capitalize">{selectedTenant.status}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Created</p>
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{selectedTenant.createdAt}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Last Active</p>
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{selectedTenant.lastActive}</p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Tenant ID</p>
                    <p className="text-sm font-medium text-slate-700 dark:text-slate-200 font-mono">{selectedTenant.id}</p>
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-3 pt-4 border-t border-slate-200 dark:border-slate-700">
                <button className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
                  Manage Tenant
                </button>
                <button className="flex-1 px-4 py-2.5 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200 text-sm font-medium rounded-lg hover:bg-slate-50 dark:hover:bg-slate-600 transition-colors">
                  View Applications
                </button>
                <button className="px-4 py-2.5 bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 text-sm font-medium rounded-lg hover:bg-red-100 dark:hover:bg-red-500/20 transition-colors">
                  Suspend
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

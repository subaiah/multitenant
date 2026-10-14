import {
  Building2,
  AppWindow,
  Users,
  TrendingUp,
  TrendingDown,
  Server,
  Activity,
  DollarSign,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { tenants, applications, activities, revenueData, usageData } from '../data/mockData';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];

export default function Dashboard() {
  const totalTenants = tenants.length;
  const activeTenants = tenants.filter((t) => t.status === 'active').length;
  const totalApps = applications.length;
  const runningApps = applications.filter((a) => a.status === 'running').length;
  const totalUsers = tenants.reduce((sum, t) => sum + t.users, 0);
  const errorApps = applications.filter((a) => a.status === 'error').length;

  const planDistribution = [
    { name: 'Enterprise', value: tenants.filter((t) => t.plan === 'enterprise').length },
    { name: 'Professional', value: tenants.filter((t) => t.plan === 'professional').length },
    { name: 'Starter', value: tenants.filter((t) => t.plan === 'starter').length },
    { name: 'Free', value: tenants.filter((t) => t.plan === 'free').length },
  ];

  const statCards = [
    {
      title: 'Total Tenants',
      value: totalTenants.toString(),
      change: '+12%',
      trend: 'up' as const,
      icon: Building2,
      color: 'blue',
    },
    {
      title: 'Active Applications',
      value: `${runningApps}/${totalApps}`,
      change: '+4%',
      trend: 'up' as const,
      icon: AppWindow,
      color: 'green',
    },
    {
      title: 'Total Users',
      value: totalUsers.toLocaleString(),
      change: '+8%',
      trend: 'up' as const,
      icon: Users,
      color: 'purple',
    },
    {
      title: 'Monthly Revenue',
      value: '$95,000',
      change: '+15%',
      trend: 'up' as const,
      icon: DollarSign,
      color: 'amber',
    },
  ];

  const colorClasses: Record<string, { bg: string; icon: string; text: string }> = {
    blue: { bg: 'bg-blue-50 dark:bg-blue-500/10', icon: 'text-blue-500', text: 'text-blue-600 dark:text-blue-400' },
    green: { bg: 'bg-green-50 dark:bg-green-500/10', icon: 'text-green-500', text: 'text-green-600 dark:text-green-400' },
    purple: { bg: 'bg-purple-50 dark:bg-purple-500/10', icon: 'text-purple-500', text: 'text-purple-600 dark:text-purple-400' },
    amber: { bg: 'bg-amber-50 dark:bg-amber-500/10', icon: 'text-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  };

  return (
    <div className="space-y-6">
      {/* Welcome Banner */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-xl p-6 text-white">
        <h2 className="text-xl font-semibold">Welcome back, Admin</h2>
        <p className="text-blue-100 mt-1">
          You have {errorApps} applications with issues and {activities.length} recent activities to review.
        </p>
        <div className="flex gap-4 mt-4">
          <div className="bg-white/10 backdrop-blur-sm rounded-lg px-4 py-2">
            <p className="text-xs text-blue-200">Active Tenants</p>
            <p className="text-2xl font-bold">{activeTenants}</p>
          </div>
          <div className="bg-white/10 backdrop-blur-sm rounded-lg px-4 py-2">
            <p className="text-xs text-blue-200">Running Apps</p>
            <p className="text-2xl font-bold">{runningApps}</p>
          </div>
          <div className="bg-white/10 backdrop-blur-sm rounded-lg px-4 py-2">
            <p className="text-xs text-blue-200">System Health</p>
            <p className="text-2xl font-bold">98.5%</p>
          </div>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((card) => {
          const Icon = card.icon;
          const colors = colorClasses[card.color];
          return (
            <div
              key={card.title}
              className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700 hover:shadow-md transition-shadow"
            >
              <div className="flex items-center justify-between">
                <div className={`p-2.5 rounded-lg ${colors.bg}`}>
                  <Icon size={20} className={colors.icon} />
                </div>
                <div
                  className={`flex items-center gap-1 text-xs font-medium ${
                    card.trend === 'up' ? 'text-green-600' : 'text-red-600'
                  }`}
                >
                  {card.trend === 'up' ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                  {card.change}
                </div>
              </div>
              <div className="mt-4">
                <p className="text-2xl font-bold text-slate-800 dark:text-white">{card.value}</p>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{card.title}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Revenue Chart */}
        <div className="lg:col-span-2 bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-base font-semibold text-slate-800 dark:text-white">Revenue Overview</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400">Monthly revenue from all tenants</p>
            </div>
            <div className="flex gap-2">
              <button className="px-3 py-1.5 text-xs font-medium bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-lg">
                12 months
              </button>
              <button className="px-3 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg">
                6 months
              </button>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={revenueData}>
              <defs>
                <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="month" stroke="#94a3b8" fontSize={12} />
              <YAxis stroke="#94a3b8" fontSize={12} tickFormatter={(v) => `$${v / 1000}k`} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1e293b',
                  border: 'none',
                  borderRadius: '8px',
                  color: '#fff',
                  fontSize: '12px',
                }}
                formatter={(value) => [`$${Number(value).toLocaleString()}`, 'Revenue']}
              />
              <Area
                type="monotone"
                dataKey="revenue"
                stroke="#3b82f6"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#colorRevenue)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Plan Distribution */}
        <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
          <h3 className="text-base font-semibold text-slate-800 dark:text-white mb-1">Plan Distribution</h3>
          <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Tenants by subscription plan</p>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={planDistribution}
                cx="50%"
                cy="50%"
                innerRadius={55}
                outerRadius={80}
                paddingAngle={4}
                dataKey="value"
              >
                {planDistribution.map((_, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1e293b',
                  border: 'none',
                  borderRadius: '8px',
                  color: '#fff',
                  fontSize: '12px',
                }}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="space-y-2 mt-4">
            {planDistribution.map((item, index) => (
              <div key={item.name} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: COLORS[index] }}
                  ></div>
                  <span className="text-sm text-slate-600 dark:text-slate-300">{item.name}</span>
                </div>
                <span className="text-sm font-medium text-slate-800 dark:text-white">{item.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Usage & Activity Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Resource Usage */}
        <div className="lg:col-span-2 bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-base font-semibold text-slate-800 dark:text-white">Resource Usage</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400">Platform resource utilization (last 7 days)</p>
            </div>
            <div className="flex items-center gap-4 text-xs">
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-full bg-blue-500"></div>
                <span className="text-slate-500 dark:text-slate-400">CPU</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-full bg-green-500"></div>
                <span className="text-slate-500 dark:text-slate-400">Memory</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="w-3 h-3 rounded-full bg-purple-500"></div>
                <span className="text-slate-500 dark:text-slate-400">Requests</span>
              </div>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={usageData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="name" stroke="#94a3b8" fontSize={12} />
              <YAxis stroke="#94a3b8" fontSize={12} unit="%" />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1e293b',
                  border: 'none',
                  borderRadius: '8px',
                  color: '#fff',
                  fontSize: '12px',
                }}
              />
              <Line type="monotone" dataKey="cpu" stroke="#3b82f6" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="memory" stroke="#10b981" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="requests" stroke="#8b5cf6" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Recent Activity */}
        <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold text-slate-800 dark:text-white">Recent Activity</h3>
            <button className="text-xs text-blue-500 hover:text-blue-600 font-medium">View all</button>
          </div>
          <div className="space-y-4 max-h-[280px] overflow-y-auto">
            {activities.slice(0, 6).map((activity) => {
              const typeColors: Record<string, string> = {
                deploy: 'bg-blue-100 text-blue-600 dark:bg-blue-500/20 dark:text-blue-400',
                config: 'bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400',
                user: 'bg-green-100 text-green-600 dark:bg-green-500/20 dark:text-green-400',
                billing: 'bg-purple-100 text-purple-600 dark:bg-purple-500/20 dark:text-purple-400',
                alert: 'bg-red-100 text-red-600 dark:bg-red-500/20 dark:text-red-400',
              };
              return (
                <div key={activity.id} className="flex items-start gap-3">
                  <div className={`p-1.5 rounded-lg ${typeColors[activity.type]}`}>
                    <Activity size={12} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-slate-700 dark:text-slate-200">
                      <span className="font-medium">{activity.user}</span>{' '}
                      {activity.action}{' '}
                      <span className="font-medium">{activity.target}</span>
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">{activity.timestamp}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Top Tenants Table */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700">
        <div className="p-5 border-b border-slate-200 dark:border-slate-700">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-slate-800 dark:text-white">Top Tenants</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400">Tenants ranked by usage</p>
            </div>
            <Link to="/tenants" className="px-4 py-2 text-sm font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 rounded-lg transition-colors">
              View all tenants
            </Link>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100 dark:border-slate-700">
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Tenant
                </th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Plan
                </th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Users
                </th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Apps
                </th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Storage
                </th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {tenants.slice(0, 5).map((tenant) => (
                <tr
                  key={tenant.id}
                  className="border-b border-slate-50 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors"
                >
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-700 dark:to-slate-600 flex items-center justify-center text-sm font-semibold text-slate-600 dark:text-slate-300">
                        {tenant.name.charAt(0)}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-slate-800 dark:text-white">{tenant.name}</p>
                        <p className="text-xs text-slate-400">{tenant.slug}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                      tenant.plan === 'enterprise'
                        ? 'bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-400'
                        : tenant.plan === 'professional'
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400'
                        : 'bg-slate-100 text-slate-700 dark:bg-slate-600 dark:text-slate-300'
                    }`}>
                      {tenant.plan}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-sm text-slate-600 dark:text-slate-300">{tenant.users}</td>
                  <td className="px-5 py-3.5 text-sm text-slate-600 dark:text-slate-300">{tenant.apps}</td>
                  <td className="px-5 py-3.5 text-sm text-slate-600 dark:text-slate-300">{tenant.storage}</td>
                  <td className="px-5 py-3.5">
                    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                      tenant.status === 'active'
                        ? 'text-green-600 dark:text-green-400'
                        : tenant.status === 'trial'
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-red-600 dark:text-red-400'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        tenant.status === 'active'
                          ? 'bg-green-500'
                          : tenant.status === 'trial'
                          ? 'bg-amber-500'
                          : 'bg-red-500'
                      }`}></span>
                      {tenant.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

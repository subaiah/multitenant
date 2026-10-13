import {
  Server,
  Cpu,
  MemoryStick,
  HardDrive,
  Wifi,
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

const serverData = [
  { time: '00:00', cpu: 32, memory: 58, network: 12 },
  { time: '04:00', cpu: 28, memory: 55, network: 8 },
  { time: '08:00', cpu: 45, memory: 62, network: 25 },
  { time: '12:00', cpu: 68, memory: 75, network: 45 },
  { time: '16:00', cpu: 72, memory: 78, network: 52 },
  { time: '20:00', cpu: 55, memory: 68, network: 35 },
  { time: '23:59', cpu: 38, memory: 60, network: 18 },
];

const servers = [
  {
    id: '1',
    name: 'prod-web-01',
    region: 'US East (Virginia)',
    status: 'healthy',
    cpu: 45,
    memory: 62,
    disk: 38,
    uptime: '45d 12h',
    type: 'Web Server',
  },
  {
    id: '2',
    name: 'prod-web-02',
    region: 'US East (Virginia)',
    status: 'healthy',
    cpu: 52,
    memory: 68,
    disk: 42,
    uptime: '45d 12h',
    type: 'Web Server',
  },
  {
    id: '3',
    name: 'prod-api-01',
    region: 'US West (Oregon)',
    status: 'healthy',
    cpu: 78,
    memory: 82,
    disk: 55,
    uptime: '30d 8h',
    type: 'API Server',
  },
  {
    id: '4',
    name: 'prod-db-01',
    region: 'US East (Virginia)',
    status: 'warning',
    cpu: 85,
    memory: 91,
    disk: 72,
    uptime: '90d 4h',
    type: 'Database',
  },
  {
    id: '5',
    name: 'prod-cache-01',
    region: 'EU West (Ireland)',
    status: 'healthy',
    cpu: 22,
    memory: 45,
    disk: 15,
    uptime: '60d 16h',
    type: 'Cache Server',
  },
  {
    id: '6',
    name: 'prod-worker-01',
    region: 'US East (Virginia)',
    status: 'healthy',
    cpu: 65,
    memory: 58,
    disk: 30,
    uptime: '15d 3h',
    type: 'Worker Node',
  },
  {
    id: '7',
    name: 'staging-01',
    region: 'US West (Oregon)',
    status: 'healthy',
    cpu: 15,
    memory: 28,
    disk: 20,
    uptime: '10d 7h',
    type: 'Staging',
  },
  {
    id: '8',
    name: 'prod-cdn-01',
    region: 'Global (Edge)',
    status: 'healthy',
    cpu: 8,
    memory: 22,
    disk: 45,
    uptime: '120d 0h',
    type: 'CDN Node',
  },
];

export default function Infrastructure() {
  const healthyCount = servers.filter((s) => s.status === 'healthy').length;
  const warningCount = servers.filter((s) => s.status === 'warning').length;
  const avgCpu = Math.round(servers.reduce((sum, s) => sum + s.cpu, 0) / servers.length);
  const avgMemory = Math.round(servers.reduce((sum, s) => sum + s.memory, 0) / servers.length);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-bold text-slate-800 dark:text-white">Infrastructure</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
          Monitor servers, resources, and system health
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-green-100 dark:bg-green-500/20">
              <CheckCircle2 size={20} className="text-green-600 dark:text-green-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-800 dark:text-white">{healthyCount}/{servers.length}</p>
              <p className="text-sm text-slate-500 dark:text-slate-400">Healthy Servers</p>
            </div>
          </div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-amber-100 dark:bg-amber-500/20">
              <AlertCircle size={20} className="text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-800 dark:text-white">{warningCount}</p>
              <p className="text-sm text-slate-500 dark:text-slate-400">Warnings</p>
            </div>
          </div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-blue-100 dark:bg-blue-500/20">
              <Cpu size={20} className="text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-800 dark:text-white">{avgCpu}%</p>
              <p className="text-sm text-slate-500 dark:text-slate-400">Avg CPU Usage</p>
            </div>
          </div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-purple-100 dark:bg-purple-500/20">
              <MemoryStick size={20} className="text-purple-600 dark:text-purple-400" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-800 dark:text-white">{avgMemory}%</p>
              <p className="text-sm text-slate-500 dark:text-slate-400">Avg Memory Usage</p>
            </div>
          </div>
        </div>
      </div>

      {/* Resource Chart */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-base font-semibold text-slate-800 dark:text-white">System Resources (24h)</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400">Aggregate resource usage across all servers</p>
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
              <span className="text-slate-500 dark:text-slate-400">Network</span>
            </div>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={250}>
          <AreaChart data={serverData}>
            <defs>
              <linearGradient id="colorCpu" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.1} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="colorMemory" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#10b981" stopOpacity={0.1} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="colorNetwork" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.1} />
                <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis dataKey="time" stroke="#94a3b8" fontSize={12} />
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
            <Area type="monotone" dataKey="cpu" stroke="#3b82f6" strokeWidth={2} fill="url(#colorCpu)" />
            <Area type="monotone" dataKey="memory" stroke="#10b981" strokeWidth={2} fill="url(#colorMemory)" />
            <Area type="monotone" dataKey="network" stroke="#8b5cf6" strokeWidth={2} fill="url(#colorNetwork)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Server List */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700">
        <div className="p-5 border-b border-slate-200 dark:border-slate-700">
          <h3 className="text-base font-semibold text-slate-800 dark:text-white">Servers</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-700">
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Server
                </th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Type
                </th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Region
                </th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Status
                </th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  CPU
                </th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Memory
                </th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Disk
                </th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Uptime
                </th>
              </tr>
            </thead>
            <tbody>
              {servers.map((server) => (
                <tr
                  key={server.id}
                  className="border-b border-slate-50 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors"
                >
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <Server size={16} className="text-slate-400" />
                      <div>
                        <p className="text-sm font-medium text-slate-800 dark:text-white font-mono">{server.name}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                      {server.type}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-sm text-slate-600 dark:text-slate-300">{server.region}</td>
                  <td className="px-5 py-3.5">
                    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                      server.status === 'healthy' ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        server.status === 'healthy' ? 'bg-green-500' : 'bg-amber-500'
                      }`}></span>
                      {server.status}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            server.cpu > 80 ? 'bg-red-500' : server.cpu > 50 ? 'bg-amber-500' : 'bg-green-500'
                          }`}
                          style={{ width: `${server.cpu}%` }}
                        ></div>
                      </div>
                      <span className="text-xs text-slate-500">{server.cpu}%</span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            server.memory > 80 ? 'bg-red-500' : server.memory > 50 ? 'bg-amber-500' : 'bg-green-500'
                          }`}
                          style={{ width: `${server.memory}%` }}
                        ></div>
                      </div>
                      <span className="text-xs text-slate-500">{server.memory}%</span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            server.disk > 80 ? 'bg-red-500' : server.disk > 50 ? 'bg-amber-500' : 'bg-green-500'
                          }`}
                          style={{ width: `${server.disk}%` }}
                        ></div>
                      </div>
                      <span className="text-xs text-slate-500">{server.disk}%</span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-sm text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
                      <Clock size={12} className="text-slate-400" />
                      {server.uptime}
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

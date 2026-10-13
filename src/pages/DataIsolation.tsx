import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Database, Shield, Layers, Table2, CheckCircle2, AlertCircle, Info, Server, HardDrive, Lock, Unlock, RefreshCw } from 'lucide-react';
import { databaseConfigs, databaseStrategies, type DatabaseStrategy } from '../data/tenantConfigs';
import { tenants } from '../data/mockData';

export default function DataIsolation() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTenantId = searchParams.get('tenant') || '1';
  const [showMigrationModal, setShowMigrationModal] = useState(false);

  const selectedTenant = tenants.find(t => t.id === selectedTenantId);
  const selectedConfig = databaseConfigs.find(c => c.tenantId === selectedTenantId);

  const updateTenant = (tenantId: string) => {
    setSearchParams({ tenant: tenantId });
  };

  const getStrategyIcon = (strategy: DatabaseStrategy) => {
    switch (strategy) {
      case 'database-per-tenant': return <Database size={20} />;
      case 'schema-per-tenant': return <Layers size={20} />;
      case 'shared-tables': return <Table2 size={20} />;
    }
  };

  const getStrategyColor = (strategy: DatabaseStrategy) => {
    switch (strategy) {
      case 'database-per-tenant': return 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400';
      case 'schema-per-tenant': return 'bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-400';
      case 'shared-tables': return 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400';
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-800 dark:text-white">Data Isolation Strategy</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Configure database isolation and multi-tenancy data architecture
          </p>
        </div>
        <button
          onClick={() => setShowMigrationModal(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <RefreshCw size={16} />
          Migrate Strategy
        </button>
      </div>

      {/* Strategy Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {databaseStrategies.map((strategy) => (
          <div
            key={strategy.id}
            className={`bg-white dark:bg-slate-800 rounded-xl border-2 p-5 transition-all cursor-pointer ${
              selectedConfig?.strategy === strategy.id
                ? 'border-blue-500 ring-2 ring-blue-500/20'
                : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
            }`}
          >
            <div className="flex items-start justify-between mb-3">
              <div className={`p-2.5 rounded-lg ${getStrategyColor(strategy.id)}`}>
                {getStrategyIcon(strategy.id)}
              </div>
              {selectedConfig?.strategy === strategy.id && (
                <CheckCircle2 size={20} className="text-blue-500" />
              )}
            </div>
            <h3 className="font-semibold text-slate-800 dark:text-white mb-2">{strategy.name}</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">{strategy.description}</p>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-400">Best for:</span>
                <span className="font-medium text-slate-700 dark:text-slate-200">{strategy.bestFor}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Tenant Selector */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-5">
        <h3 className="font-semibold text-slate-800 dark:text-white mb-4">Select Tenant</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {tenants.map((tenant) => {
            const config = databaseConfigs.find(c => c.tenantId === tenant.id);
            return (
              <button
                key={tenant.id}
                onClick={() => updateTenant(tenant.id)}
                className={`p-3 rounded-lg border-2 text-left transition-all ${
                  selectedTenantId === tenant.id
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-500/10'
                    : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
                }`}
              >
                <p className="text-sm font-medium text-slate-800 dark:text-white truncate">{tenant.name}</p>
                <div className="flex items-center gap-1.5 mt-1">
                  {config && getStrategyIcon(config.strategy)}
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {config?.strategy === 'database-per-tenant' ? 'Dedicated DB' :
                     config?.strategy === 'schema-per-tenant' ? 'Schema' : 'Shared'}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Current Configuration */}
      {selectedConfig && selectedTenant && (
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h3 className="text-lg font-semibold text-slate-800 dark:text-white">
                {selectedTenant.name} - Database Configuration
              </h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                Current strategy: <span className="font-medium">{databaseStrategies.find(s => s.id === selectedConfig.strategy)?.name}</span>
              </p>
            </div>
            <div className={`px-3 py-1.5 rounded-lg text-sm font-medium ${getStrategyColor(selectedConfig.strategy)}`}>
              {selectedConfig.strategy === 'database-per-tenant' ? 'Maximum Isolation' :
               selectedConfig.strategy === 'schema-per-tenant' ? 'Balanced' : 'Shared'}
            </div>
          </div>

          {/* Architecture Diagram */}
          <div className="bg-slate-50 dark:bg-slate-900 rounded-xl p-6 mb-6">
            <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-4">Architecture Overview</h4>
            {selectedConfig.strategy === 'database-per-tenant' && (
              <div className="flex items-center justify-center gap-4">
                <div className="text-center">
                  <div className="w-20 h-20 bg-blue-100 dark:bg-blue-500/20 rounded-xl flex items-center justify-center mb-2">
                    <Database size={32} className="text-blue-600 dark:text-blue-400" />
                  </div>
                  <p className="text-xs font-medium text-slate-700 dark:text-slate-200">{selectedTenant.name}</p>
                  <p className="text-xs text-slate-400">Tenant DB</p>
                </div>
                <div className="text-slate-400">→</div>
                <div className="text-center">
                  <div className="w-20 h-20 bg-green-100 dark:bg-green-500/20 rounded-xl flex items-center justify-center mb-2">
                    <Server size={32} className="text-green-600 dark:text-green-400" />
                  </div>
                  <p className="text-xs font-medium text-slate-700 dark:text-slate-200">Dedicated</p>
                  <p className="text-xs text-slate-400">{selectedConfig.provider}</p>
                </div>
              </div>
            )}
            {selectedConfig.strategy === 'schema-per-tenant' && (
              <div className="flex items-center justify-center gap-4">
                <div className="text-center">
                  <div className="w-20 h-20 bg-purple-100 dark:bg-purple-500/20 rounded-xl flex items-center justify-center mb-2">
                    <Layers size={32} className="text-purple-600 dark:text-purple-400" />
                  </div>
                  <p className="text-xs font-medium text-slate-700 dark:text-slate-200">{selectedConfig.schemaName}</p>
                  <p className="text-xs text-slate-400">Tenant Schema</p>
                </div>
                <div className="text-slate-400">→</div>
                <div className="text-center">
                  <div className="w-20 h-20 bg-blue-100 dark:bg-blue-500/20 rounded-xl flex items-center justify-center mb-2">
                    <Database size={32} className="text-blue-600 dark:text-blue-400" />
                  </div>
                  <p className="text-xs font-medium text-slate-700 dark:text-slate-200">Shared DB</p>
                  <p className="text-xs text-slate-400">{selectedConfig.provider}</p>
                </div>
              </div>
            )}
            {selectedConfig.strategy === 'shared-tables' && (
              <div className="flex items-center justify-center gap-4">
                <div className="text-center">
                  <div className="w-20 h-20 bg-green-100 dark:bg-green-500/20 rounded-xl flex items-center justify-center mb-2">
                    <Table2 size={32} className="text-green-600 dark:text-green-400" />
                  </div>
                  <p className="text-xs font-medium text-slate-700 dark:text-slate-200">All Tenants</p>
                  <p className="text-xs text-slate-400">Shared Tables</p>
                </div>
                <div className="text-slate-400">→</div>
                <div className="text-center">
                  <div className="w-20 h-20 bg-blue-100 dark:bg-blue-500/20 rounded-xl flex items-center justify-center mb-2">
                    <Database size={32} className="text-blue-600 dark:text-blue-400" />
                  </div>
                  <p className="text-xs font-medium text-slate-700 dark:text-slate-200">Single DB</p>
                  <p className="text-xs text-slate-400">{selectedConfig.provider}</p>
                </div>
              </div>
            )}
          </div>

          {/* Configuration Details */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Connection Details</h4>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-slate-400">Provider</label>
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200 capitalize">{selectedConfig.provider}</p>
                </div>
                <div>
                  <label className="text-xs text-slate-400">Region</label>
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{selectedConfig.region}</p>
                </div>
                {selectedConfig.connectionString && (
                  <div>
                    <label className="text-xs text-slate-400">Connection String</label>
                    <p className="text-sm font-mono text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-900 px-3 py-2 rounded-lg mt-1 break-all">
                      {selectedConfig.connectionString}
                    </p>
                  </div>
                )}
                {selectedConfig.schemaName && (
                  <div>
                    <label className="text-xs text-slate-400">Schema Name</label>
                    <p className="text-sm font-mono text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-900 px-3 py-2 rounded-lg mt-1">
                      {selectedConfig.schemaName}
                    </p>
                  </div>
                )}
                {selectedConfig.tenantColumn && (
                  <div>
                    <label className="text-xs text-slate-400">Tenant Column</label>
                    <p className="text-sm font-mono text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-900 px-3 py-2 rounded-lg mt-1">
                      {selectedConfig.tenantColumn}
                    </p>
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-4">
              <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Security & Limits</h4>
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                  <div className="flex items-center gap-2">
                    {selectedConfig.encryptionAtRest ? (
                      <Lock size={16} className="text-green-600 dark:text-green-400" />
                    ) : (
                      <Unlock size={16} className="text-amber-600 dark:text-amber-400" />
                    )}
                    <span className="text-sm text-slate-700 dark:text-slate-200">Encryption at Rest</span>
                  </div>
                  <span className={`text-xs font-medium ${selectedConfig.encryptionAtRest ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}`}>
                    {selectedConfig.encryptionAtRest ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
                <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                  <div className="flex items-center gap-2">
                    <RefreshCw size={16} className="text-blue-600 dark:text-blue-400" />
                    <span className="text-sm text-slate-700 dark:text-slate-200">Automated Backups</span>
                  </div>
                  <span className={`text-xs font-medium ${selectedConfig.backupEnabled ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                    {selectedConfig.backupEnabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
                <div>
                  <label className="text-xs text-slate-400">Max Connections</label>
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{selectedConfig.maxConnections}</p>
                </div>
                <div>
                  <label className="text-xs text-slate-400">Storage Limit</label>
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{selectedConfig.storageLimit}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Migration Modal */}
      {showMigrationModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-y-auto">
            <div className="p-6 border-b border-slate-200 dark:border-slate-700">
              <h3 className="text-xl font-bold text-slate-800 dark:text-white">Migrate Database Strategy</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                Change the data isolation strategy for {selectedTenant?.name}
              </p>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <AlertCircle size={20} className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Warning: Migration Impact</p>
                    <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                      Changing database strategy will require downtime and data migration. This operation cannot be undone automatically.
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700 dark:text-slate-200">New Strategy</label>
                {databaseStrategies.map((strategy) => (
                  <label
                    key={strategy.id}
                    className={`flex items-start gap-3 p-4 rounded-lg border-2 cursor-pointer transition-all ${
                      selectedConfig?.strategy === strategy.id
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-500/10'
                        : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="strategy"
                      defaultChecked={selectedConfig?.strategy === strategy.id}
                      className="mt-1"
                    />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-slate-800 dark:text-white">{strategy.name}</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{strategy.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
            <div className="p-6 border-t border-slate-200 dark:border-slate-700 flex gap-3">
              <button
                onClick={() => setShowMigrationModal(false)}
                className="flex-1 px-4 py-2.5 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200 text-sm font-medium rounded-lg hover:bg-slate-50 dark:hover:bg-slate-600 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => setShowMigrationModal(false)}
                className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                Start Migration
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

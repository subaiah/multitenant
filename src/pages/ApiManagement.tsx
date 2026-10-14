import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Server, Globe, Shield, Zap, Lock, Unlock, Code, GitBranch, CheckCircle2, AlertCircle, ExternalLink, Settings } from 'lucide-react';
import { apiConfigs, type ApiConfig } from '../data/tenantConfigs';
import { tenants } from '../data/mockData';

export default function ApiManagement() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTenantId = searchParams.get('tenant') || '1';
  const [showBffModal, setShowBffModal] = useState(false);

  const selectedTenant = tenants.find(t => t.id === selectedTenantId);
  const selectedConfig = apiConfigs.find(c => c.tenantId === selectedTenantId);

  const updateTenant = (tenantId: string) => {
    setSearchParams({ tenant: tenantId });
  };

  const getGatewayColor = (gateway: string) => {
    switch (gateway) {
      case 'kong': return 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-400';
      case 'apigee': return 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400';
      case 'aws-apigateway': return 'bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-400';
      case 'azure-apim': return 'bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-400';
      case 'custom': return 'bg-slate-100 text-slate-700 dark:bg-slate-600 dark:text-slate-300';
      default: return 'bg-slate-100 text-slate-700 dark:bg-slate-600 dark:text-slate-300';
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-800 dark:text-white">API & BFF Management</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Configure backend APIs, BFF (Backend for Frontend) services, and API gateways
          </p>
        </div>
        <button
          onClick={() => setShowBffModal(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <Code size={16} />
          Configure BFF
        </button>
      </div>

      {/* BFF Pattern Overview */}
      <div className="bg-gradient-to-br from-blue-50 to-purple-50 dark:from-blue-500/10 dark:to-purple-500/10 rounded-xl border border-blue-200 dark:border-blue-500/30 p-6">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-blue-100 dark:bg-blue-500/20 rounded-xl">
            <GitBranch size={24} className="text-blue-600 dark:text-blue-400" />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-slate-800 dark:text-white mb-2">Backend for Frontend (BFF) Pattern</h3>
            <p className="text-sm text-slate-600 dark:text-slate-300 mb-4">
              The BFF pattern provides a dedicated backend service for each frontend application, enabling optimized API aggregation, 
              security token management, and tenant-specific customizations.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-slate-200 dark:border-slate-700">
                <div className="flex items-center gap-2 mb-2">
                  <CheckCircle2 size={16} className="text-green-600 dark:text-green-400" />
                  <span className="text-sm font-medium text-slate-800 dark:text-white">Token Management</span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Securely store and manage OAuth tokens server-side
                </p>
              </div>
              <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-slate-200 dark:border-slate-700">
                <div className="flex items-center gap-2 mb-2">
                  <CheckCircle2 size={16} className="text-green-600 dark:text-green-400" />
                  <span className="text-sm font-medium text-slate-800 dark:text-white">API Aggregation</span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Combine multiple backend calls into single frontend requests
                </p>
              </div>
              <div className="bg-white dark:bg-slate-800 rounded-lg p-3 border border-slate-200 dark:border-slate-700">
                <div className="flex items-center gap-2 mb-2">
                  <CheckCircle2 size={16} className="text-green-600 dark:text-green-400" />
                  <span className="text-sm font-medium text-slate-800 dark:text-white">Tenant Isolation</span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Inject tenant context and enforce data isolation
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Tenant Selector */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-5">
        <h3 className="font-semibold text-slate-800 dark:text-white mb-4">Select Tenant</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {tenants.map((tenant) => {
            const config = apiConfigs.find(c => c.tenantId === tenant.id);
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
                  {config?.bffEnabled ? (
                    <>
                      <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                      <span className="text-xs text-green-600 dark:text-green-400">BFF Active</span>
                    </>
                  ) : (
                    <>
                      <div className="w-2 h-2 bg-slate-400 rounded-full"></div>
                      <span className="text-xs text-slate-400">Direct API</span>
                    </>
                  )}
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
                {selectedTenant.name} - API Configuration
              </h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                Backend API and BFF service settings
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`px-3 py-1.5 rounded-lg text-xs font-medium ${getGatewayColor(selectedConfig.apiGateway)}`}>
                {selectedConfig.apiGateway.replace('-', ' ').toUpperCase()}
              </span>
              {selectedConfig.bffEnabled && (
                <span className="px-3 py-1.5 bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-400 text-xs font-medium rounded-lg">
                  BFF Enabled
                </span>
              )}
            </div>
          </div>

          {/* Architecture Diagram */}
          <div className="bg-slate-50 dark:bg-slate-900 rounded-xl p-6 mb-6">
            <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-4">Request Flow</h4>
            {selectedConfig.bffEnabled ? (
              <div className="flex items-center justify-center gap-3 flex-wrap">
                <div className="text-center">
                  <div className="w-20 h-20 bg-blue-100 dark:bg-blue-500/20 rounded-xl flex items-center justify-center mb-2">
                    <Globe size={32} className="text-blue-600 dark:text-blue-400" />
                  </div>
                  <p className="text-xs font-medium text-slate-700 dark:text-slate-200">Frontend</p>
                  <p className="text-xs text-slate-400">React App</p>
                </div>
                <div className="text-slate-400">→</div>
                <div className="text-center">
                  <div className="w-20 h-20 bg-purple-100 dark:bg-purple-500/20 rounded-xl flex items-center justify-center mb-2">
                    <Code size={32} className="text-purple-600 dark:text-purple-400" />
                  </div>
                  <p className="text-xs font-medium text-slate-700 dark:text-slate-200">BFF</p>
                  <p className="text-xs text-slate-400">Node.js</p>
                </div>
                <div className="text-slate-400">→</div>
                <div className="text-center">
                  <div className="w-20 h-20 bg-orange-100 dark:bg-orange-500/20 rounded-xl flex items-center justify-center mb-2">
                    <Server size={32} className="text-orange-600 dark:text-orange-400" />
                  </div>
                  <p className="text-xs font-medium text-slate-700 dark:text-slate-200">API Gateway</p>
                  <p className="text-xs text-slate-400">{selectedConfig.apiGateway}</p>
                </div>
                <div className="text-slate-400">→</div>
                <div className="text-center">
                  <div className="w-20 h-20 bg-green-100 dark:bg-green-500/20 rounded-xl flex items-center justify-center mb-2">
                    <Zap size={32} className="text-green-600 dark:text-green-400" />
                  </div>
                  <p className="text-xs font-medium text-slate-700 dark:text-slate-200">Microservices</p>
                  <p className="text-xs text-slate-400">Backend APIs</p>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center gap-3 flex-wrap">
                <div className="text-center">
                  <div className="w-20 h-20 bg-blue-100 dark:bg-blue-500/20 rounded-xl flex items-center justify-center mb-2">
                    <Globe size={32} className="text-blue-600 dark:text-blue-400" />
                  </div>
                  <p className="text-xs font-medium text-slate-700 dark:text-slate-200">Frontend</p>
                  <p className="text-xs text-slate-400">React App</p>
                </div>
                <div className="text-slate-400">→</div>
                <div className="text-center">
                  <div className="w-20 h-20 bg-orange-100 dark:bg-orange-500/20 rounded-xl flex items-center justify-center mb-2">
                    <Server size={32} className="text-orange-600 dark:text-orange-400" />
                  </div>
                  <p className="text-xs font-medium text-slate-700 dark:text-slate-200">API Gateway</p>
                  <p className="text-xs text-slate-400">{selectedConfig.apiGateway}</p>
                </div>
                <div className="text-slate-400">→</div>
                <div className="text-center">
                  <div className="w-20 h-20 bg-green-100 dark:bg-green-500/20 rounded-xl flex items-center justify-center mb-2">
                    <Zap size={32} className="text-green-600 dark:text-green-400" />
                  </div>
                  <p className="text-xs font-medium text-slate-700 dark:text-slate-200">Microservices</p>
                  <p className="text-xs text-slate-400">Backend APIs</p>
                </div>
              </div>
            )}
          </div>

          {/* Configuration Details */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200">API Gateway</h4>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-slate-400">Gateway Provider</label>
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200 capitalize">{selectedConfig.apiGateway.replace('-', ' ')}</p>
                </div>
                <div>
                  <label className="text-xs text-slate-400">Authentication Type</label>
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200 uppercase">{selectedConfig.authType}</p>
                </div>
                <div>
                  <label className="text-xs text-slate-400">API Versioning</label>
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200 capitalize">{selectedConfig.versioning}</p>
                </div>
                <div>
                  <label className="text-xs text-slate-400">Rate Limit</label>
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{selectedConfig.rateLimit.toLocaleString()} requests/hour</p>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Security & CORS</h4>
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                  <div className="flex items-center gap-2">
                    {selectedConfig.corsEnabled ? (
                      <Unlock size={16} className="text-green-600 dark:text-green-400" />
                    ) : (
                      <Lock size={16} className="text-red-600 dark:text-red-400" />
                    )}
                    <span className="text-sm text-slate-700 dark:text-slate-200">CORS</span>
                  </div>
                  <span className={`text-xs font-medium ${selectedConfig.corsEnabled ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                    {selectedConfig.corsEnabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
                {selectedConfig.corsEnabled && selectedConfig.allowedOrigins.length > 0 && (
                  <div>
                    <label className="text-xs text-slate-400">Allowed Origins</label>
                    <div className="mt-1 space-y-1">
                      {selectedConfig.allowedOrigins.map((origin) => (
                        <p key={origin} className="text-xs font-mono text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded">
                          {origin}
                        </p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* BFF Configuration */}
          {selectedConfig.bffEnabled && (
            <div className="mt-6 pt-6 border-t border-slate-200 dark:border-slate-700">
              <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">BFF Service</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-slate-400">BFF URL</label>
                  <p className="text-sm font-mono text-blue-600 dark:text-blue-400 bg-slate-100 dark:bg-slate-900 px-3 py-2 rounded-lg mt-1 flex items-center gap-2">
                    {selectedConfig.bffUrl}
                    <ExternalLink size={12} />
                  </p>
                </div>
                <div>
                  <label className="text-xs text-slate-400">Runtime</label>
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200 mt-1">Node.js 20 LTS</p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* BFF Configuration Modal */}
      {showBffModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-y-auto">
            <div className="p-6 border-b border-slate-200 dark:border-slate-700">
              <h3 className="text-xl font-bold text-slate-800 dark:text-white">Configure BFF Service</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                Set up Backend for Frontend service for {selectedTenant?.name}
              </p>
            </div>
            <div className="p-6 space-y-4">
              <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-900 rounded-lg">
                <div>
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Enable BFF Service</p>
                  <p className="text-xs text-slate-400 mt-1">Deploy a dedicated BFF for this tenant</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" defaultChecked={selectedConfig?.bffEnabled} className="sr-only peer" />
                  <div className="w-11 h-6 bg-slate-200 dark:bg-slate-600 peer-focus:ring-2 peer-focus:ring-blue-500/20 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">BFF URL</label>
                <input
                  type="text"
                  defaultValue={selectedConfig?.bffUrl || ''}
                  placeholder="https://bff.tenant-domain.com"
                  className="w-full px-4 py-2.5 text-sm bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">API Gateway</label>
                <select className="w-full px-4 py-2.5 text-sm bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200">
                  <option value="azure-apim">Azure API Management</option>
                  <option value="aws-apigateway">AWS API Gateway</option>
                  <option value="kong">Kong</option>
                  <option value="apigee">Apigee</option>
                  <option value="custom">Custom</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">Authentication Type</label>
                <select className="w-full px-4 py-2.5 text-sm bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200">
                  <option value="oauth2">OAuth 2.0</option>
                  <option value="jwt">JWT</option>
                  <option value="api-key">API Key</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">Rate Limit (requests/hour)</label>
                <input
                  type="number"
                  defaultValue={selectedConfig?.rateLimit || 5000}
                  className="w-full px-4 py-2.5 text-sm bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200"
                />
              </div>
            </div>
            <div className="p-6 border-t border-slate-200 dark:border-slate-700 flex gap-3">
              <button
                onClick={() => setShowBffModal(false)}
                className="flex-1 px-4 py-2.5 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200 text-sm font-medium rounded-lg hover:bg-slate-50 dark:hover:bg-slate-600 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => setShowBffModal(false)}
                className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                Deploy BFF
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

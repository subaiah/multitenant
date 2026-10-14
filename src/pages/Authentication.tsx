import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Shield, Key, Users, Clock, Lock, CheckCircle2, XCircle, ExternalLink, Plus, Settings, AlertTriangle } from 'lucide-react';
import { authConfigs, ssoProviders, type AuthProvider, type AuthConfig } from '../data/tenantConfigs';
import { tenants } from '../data/mockData';

export default function Authentication() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTenantId = searchParams.get('tenant') || '1';
  const [showProviderModal, setShowProviderModal] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<typeof ssoProviders[0] | null>(null);

  const selectedTenant = tenants.find(t => t.id === selectedTenantId);
  const selectedConfig = authConfigs.find(c => c.tenantId === selectedTenantId);

  const updateTenant = (tenantId: string) => {
    setSearchParams({ tenant: tenantId });
  };

  const getProviderIcon = (providerId: AuthProvider) => {
    const provider = ssoProviders.find(p => p.id === providerId);
    return provider?.color || 'bg-gray-500';
  };

  const getProviderName = (providerId: AuthProvider) => {
    const provider = ssoProviders.find(p => p.id === providerId);
    return provider?.name || providerId;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-800 dark:text-white">Authentication & SSO</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Configure identity providers and authentication methods per tenant
          </p>
        </div>
        <button
          onClick={() => setShowProviderModal(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <Plus size={16} />
          Add Provider
        </button>
      </div>

      {/* Available SSO Providers */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-5">
        <h3 className="font-semibold text-slate-800 dark:text-white mb-4">Supported Identity Providers</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {ssoProviders.map((provider) => (
            <div
              key={provider.id}
              className="p-4 rounded-lg border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 transition-all cursor-pointer group"
              onClick={() => {
                setSelectedProvider(provider);
                setShowProviderModal(true);
              }}
            >
              <div className={`w-10 h-10 ${provider.color} rounded-lg flex items-center justify-center text-white font-bold text-sm mb-3`}>
                {provider.shortName.charAt(0)}
              </div>
              <p className="text-sm font-medium text-slate-800 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                {provider.shortName}
              </p>
              <p className="text-xs text-slate-400 mt-1 line-clamp-1">{provider.description}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Tenant Selector */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-5">
        <h3 className="font-semibold text-slate-800 dark:text-white mb-4">Select Tenant</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {tenants.map((tenant) => {
            const config = authConfigs.find(c => c.tenantId === tenant.id);
            const enabledProviders = config?.providers.filter(p => p.enabled).length || 0;
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
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  {enabledProviders} provider{enabledProviders !== 1 ? 's' : ''} enabled
                </p>
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
                {selectedTenant.name} - Authentication
              </h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                Identity providers and security settings
              </p>
            </div>
            <div className="flex items-center gap-2">
              {selectedConfig.ssoOnly && (
                <span className="px-3 py-1.5 bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-400 text-xs font-medium rounded-lg">
                  SSO Only
                </span>
              )}
            </div>
          </div>

          {/* Enabled Providers */}
          <div className="mb-6">
            <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">Enabled Providers</h4>
            <div className="space-y-3">
              {selectedConfig.providers.map((provider) => (
                <div
                  key={provider.id}
                  className={`flex items-center justify-between p-4 rounded-lg border-2 ${
                    provider.enabled
                      ? 'border-green-200 dark:border-green-500/30 bg-green-50 dark:bg-green-500/5'
                      : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900'
                  }`}
                >
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 ${getProviderIcon(provider.id)} rounded-lg flex items-center justify-center text-white font-bold`}>
                      {getProviderName(provider.id).charAt(0)}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-slate-800 dark:text-white">{provider.name}</p>
                        {provider.enabled ? (
                          <CheckCircle2 size={16} className="text-green-600 dark:text-green-400" />
                        ) : (
                          <XCircle size={16} className="text-slate-400" />
                        )}
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        {provider.enabled ? 'Active' : 'Disabled'}
                        {provider.autoProvision && provider.enabled && ' • Auto-provisioning enabled'}
                      </p>
                      {provider.enabled && provider.clientId && (
                        <p className="text-xs font-mono text-slate-400 mt-1 bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded inline-block">
                          Client ID: {provider.clientId.substring(0, 20)}...
                        </p>
                      )}
                    </div>
                  </div>
                  <button className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400">
                    <Settings size={16} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Security Settings */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Security Settings</h4>
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                  <div className="flex items-center gap-2">
                    <Shield size={16} className="text-blue-600 dark:text-blue-400" />
                    <span className="text-sm text-slate-700 dark:text-slate-200">Multi-Factor Auth</span>
                  </div>
                  <span className={`text-xs font-medium ${selectedConfig.mfaEnabled ? 'text-green-600 dark:text-green-400' : 'text-slate-400'}`}>
                    {selectedConfig.mfaEnabled ? 'Enabled' : 'Disabled'}
                  </span>
                </div>
                <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                  <div className="flex items-center gap-2">
                    <Lock size={16} className="text-purple-600 dark:text-purple-400" />
                    <span className="text-sm text-slate-700 dark:text-slate-200">Password Policy</span>
                  </div>
                  <span className="text-xs font-medium text-slate-700 dark:text-slate-200 capitalize">
                    {selectedConfig.passwordPolicy.replace('-', ' ')}
                  </span>
                </div>
                <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-900 rounded-lg">
                  <div className="flex items-center gap-2">
                    <Clock size={16} className="text-amber-600 dark:text-amber-400" />
                    <span className="text-sm text-slate-700 dark:text-slate-200">Session Timeout</span>
                  </div>
                  <span className="text-xs font-medium text-slate-700 dark:text-slate-200">
                    {selectedConfig.sessionTimeout} minutes
                  </span>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Provider Details</h4>
              {selectedConfig.providers.filter(p => p.enabled).length > 0 ? (
                <div className="space-y-3">
                  {selectedConfig.providers.filter(p => p.enabled).map((provider) => (
                    <div key={provider.id} className="p-3 bg-slate-50 dark:bg-slate-900 rounded-lg space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-400">Provider</span>
                        <span className="text-xs font-medium text-slate-700 dark:text-slate-200">{provider.name}</span>
                      </div>
                      {provider.tenantId && (
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-slate-400">Tenant ID</span>
                          <span className="text-xs font-mono text-slate-700 dark:text-slate-200">{provider.tenantId}</span>
                        </div>
                      )}
                      {provider.domain && (
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-slate-400">Domain</span>
                          <span className="text-xs font-mono text-slate-700 dark:text-slate-200">{provider.domain}</span>
                        </div>
                      )}
                      {provider.scopes && (
                        <div>
                          <span className="text-xs text-slate-400">Scopes</span>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {provider.scopes.map((scope) => (
                              <span key={scope} className="text-xs bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400 px-2 py-0.5 rounded">
                                {scope}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-4 bg-slate-50 dark:bg-slate-900 rounded-lg text-center">
                  <p className="text-sm text-slate-500 dark:text-slate-400">No providers enabled</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Provider Configuration Modal */}
      {showProviderModal && selectedProvider && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-y-auto">
            <div className="p-6 border-b border-slate-200 dark:border-slate-700">
              <div className="flex items-center gap-4">
                <div className={`w-14 h-14 ${selectedProvider.color} rounded-xl flex items-center justify-center text-white font-bold text-xl`}>
                  {selectedProvider.shortName.charAt(0)}
                </div>
                <div>
                  <h3 className="text-xl font-bold text-slate-800 dark:text-white">{selectedProvider.name}</h3>
                  <p className="text-sm text-slate-500 dark:text-slate-400">{selectedProvider.description}</p>
                </div>
              </div>
            </div>
            <div className="p-6 space-y-6">
              {/* Features */}
              <div>
                <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">Supported Features</h4>
                <div className="flex flex-wrap gap-2">
                  {selectedProvider.features.map((feature) => (
                    <span key={feature} className="text-xs bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 px-3 py-1.5 rounded-lg">
                      {feature}
                    </span>
                  ))}
                </div>
              </div>

              {/* Configuration Form */}
              <div className="space-y-4">
                <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Configuration</h4>
                {selectedProvider.id === 'entra' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">Client ID</label>
                      <input
                        type="text"
                        placeholder="Application (client) ID"
                        className="w-full px-4 py-2.5 text-sm bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">Tenant ID</label>
                      <input
                        type="text"
                        placeholder="your-tenant.onmicrosoft.com"
                        className="w-full px-4 py-2.5 text-sm bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">Client Secret</label>
                      <input
                        type="password"
                        placeholder="••••••••••••"
                        className="w-full px-4 py-2.5 text-sm bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200"
                      />
                    </div>
                  </>
                )}
                {selectedProvider.id === 'google' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">OAuth 2.0 Client ID</label>
                      <input
                        type="text"
                        placeholder="xxxxx.apps.googleusercontent.com"
                        className="w-full px-4 py-2.5 text-sm bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">Client Secret</label>
                      <input
                        type="password"
                        placeholder="••••••••••••"
                        className="w-full px-4 py-2.5 text-sm bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200"
                      />
                    </div>
                  </>
                )}
                {(selectedProvider.id === 'okta' || selectedProvider.id === 'auth0') && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">Domain</label>
                      <input
                        type="text"
                        placeholder={selectedProvider.id === 'okta' ? 'your-org.okta.com' : 'your-org.auth0.com'}
                        className="w-full px-4 py-2.5 text-sm bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">Client ID</label>
                      <input
                        type="text"
                        placeholder="Client ID"
                        className="w-full px-4 py-2.5 text-sm bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">Client Secret</label>
                      <input
                        type="password"
                        placeholder="••••••••••••"
                        className="w-full px-4 py-2.5 text-sm bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200"
                      />
                    </div>
                  </>
                )}
                {selectedProvider.id === 'custom-oidc' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">Issuer URL</label>
                      <input
                        type="text"
                        placeholder="https://auth.your-domain.com"
                        className="w-full px-4 py-2.5 text-sm bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">Client ID</label>
                      <input
                        type="text"
                        placeholder="Client ID"
                        className="w-full px-4 py-2.5 text-sm bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">Client Secret</label>
                      <input
                        type="password"
                        placeholder="••••••••••••"
                        className="w-full px-4 py-2.5 text-sm bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200"
                      />
                    </div>
                  </>
                )}
              </div>

              {/* Auto Provisioning */}
              <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-900 rounded-lg">
                <div>
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Auto-Provision Users</p>
                  <p className="text-xs text-slate-400 mt-1">Automatically create user accounts on first login</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" defaultChecked className="sr-only peer" />
                  <div className="w-11 h-6 bg-slate-200 dark:bg-slate-600 peer-focus:ring-2 peer-focus:ring-blue-500/20 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>
            </div>
            <div className="p-6 border-t border-slate-200 dark:border-slate-700 flex gap-3">
              <button
                onClick={() => setShowProviderModal(false)}
                className="flex-1 px-4 py-2.5 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200 text-sm font-medium rounded-lg hover:bg-slate-50 dark:hover:bg-slate-600 transition-colors"
              >
                Cancel
              </button>
              <a
                href={selectedProvider.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 px-4 py-2.5 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200 text-sm font-medium rounded-lg hover:bg-slate-50 dark:hover:bg-slate-600 transition-colors"
              >
                <ExternalLink size={14} />
                Documentation
              </a>
              <button
                onClick={() => setShowProviderModal(false)}
                className="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                Save Configuration
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

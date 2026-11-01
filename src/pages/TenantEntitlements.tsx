import { useState, useEffect } from 'react';
import { Package, Plus, Trash2, CheckCircle, XCircle, Calendar } from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api-client';

interface Application {
  id: string;
  key: string;
  name: string;
  description?: string;
  version: string;
  status: string;
}

interface TenantApplication {
  id: string;
  applicationId: string;
  state: string;
  validFrom: string;
  validTo?: string;
  application: Application;
}

export default function TenantEntitlements() {
  const [availableApps, setAvailableApps] = useState<Application[]>([]);
  const [entitledApps, setEntitledApps] = useState<TenantApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedAppId, setSelectedAppId] = useState('');
  const [validTo, setValidTo] = useState('');

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [appsResponse, entitlementsResponse] = await Promise.all([
        apiGet<{ applications: Application[] }>('/applications'),
        apiGet<{ tenantApplications: TenantApplication[] }>('/tenant-applications'),
      ]);
      setAvailableApps(appsResponse.applications);
      setEntitledApps(entitlementsResponse.tenantApplications);
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddEntitlement = async () => {
    if (!selectedAppId) return;
    try {
      await apiPost('/tenant-applications', {
        applicationId: selectedAppId,
        state: 'ENABLED',
        validTo: validTo || undefined,
      });
      setShowAddModal(false);
      setSelectedAppId('');
      setValidTo('');
      fetchData();
    } catch (error) {
      console.error('Failed to add entitlement:', error);
      alert('Failed to add entitlement');
    }
  };

  const handleUpdateEntitlement = async (id: string, state: string) => {
    try {
      await apiPatch(`/tenant-applications/${id}`, { state });
      fetchData();
    } catch (error) {
      console.error('Failed to update entitlement:', error);
      alert('Failed to update entitlement');
    }
  };

  const handleRemoveEntitlement = async (id: string) => {
    if (!confirm('Are you sure you want to remove this entitlement?')) return;
    try {
      await apiDelete(`/tenant-applications/${id}`);
      fetchData();
    } catch (error) {
      console.error('Failed to remove entitlement:', error);
      alert('Failed to remove entitlement');
    }
  };

  const getAvailableApps = () => {
    const entitledAppIds = new Set(entitledApps.map((ea) => ea.applicationId));
    return availableApps.filter((app) => !entitledAppIds.has(app.id) && app.status === 'ACTIVE');
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const isExpired = (validTo?: string) => {
    if (!validTo) return false;
    return new Date(validTo) < new Date();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-white">Application Entitlements</h1>
        <p className="text-slate-600 dark:text-slate-400 mt-1">
          Manage which applications your tenant can access
        </p>
      </div>

      <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
        <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
              Enabled Applications
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
              {entitledApps.length} application{entitledApps.length !== 1 ? 's' : ''} enabled
            </p>
          </div>
          <button
            onClick={() => setShowAddModal(true)}
            className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors flex items-center gap-2"
          >
            <Plus size={20} />
            Add Application
          </button>
        </div>

        <div className="divide-y divide-slate-200 dark:divide-slate-700">
          {entitledApps.map((entitlement) => {
            const expired = isExpired(entitlement.validTo);
            return (
              <div key={entitlement.id} className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-blue-100 dark:bg-blue-900 rounded-lg">
                        <Package className="text-blue-600 dark:text-blue-400" size={24} />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-medium text-slate-900 dark:text-white">
                            {entitlement.application.name}
                          </h3>
                          <span
                            className={`px-2 py-0.5 text-xs rounded ${
                              entitlement.state === 'ENABLED' && !expired
                                ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                                : entitlement.state === 'TRIAL'
                                ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300'
                                : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
                            }`}
                          >
                            {expired ? 'EXPIRED' : entitlement.state}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-mono">
                          {entitlement.application.key}
                        </p>
                        {entitlement.application.description && (
                          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                            {entitlement.application.description}
                          </p>
                        )}
                        <div className="flex items-center gap-4 mt-2 text-xs text-slate-500 dark:text-slate-400">
                          <span className="flex items-center gap-1">
                            <Calendar size={12} />
                            Enabled: {formatDate(entitlement.validFrom)}
                          </span>
                          {entitlement.validTo && (
                            <span className="flex items-center gap-1">
                              <Calendar size={12} />
                              Expires: {formatDate(entitlement.validTo)}
                            </span>
                          )}
                          <span>Version: {entitlement.application.version}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {entitlement.state === 'ENABLED' ? (
                      <button
                        onClick={() => handleUpdateEntitlement(entitlement.id, 'DISABLED')}
                        className="px-3 py-1 text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
                      >
                        Disable
                      </button>
                    ) : (
                      <button
                        onClick={() => handleUpdateEntitlement(entitlement.id, 'ENABLED')}
                        className="px-3 py-1 text-sm text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 rounded-lg transition-colors"
                      >
                        Enable
                      </button>
                    )}
                    <button
                      onClick={() => handleRemoveEntitlement(entitlement.id)}
                      className="p-2 text-slate-400 hover:text-red-500 transition-colors"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
          {entitledApps.length === 0 && (
            <div className="p-12 text-center text-slate-500 dark:text-slate-400">
              <Package className="mx-auto mb-4" size={48} />
              <p>No applications enabled yet</p>
              <p className="text-sm mt-1">Click "Add Application" to get started</p>
            </div>
          )}
        </div>
      </div>

      {/* Add Entitlement Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-slate-800 rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-semibold text-slate-900 dark:text-white mb-4">
              Add Application
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Select Application
                </label>
                <select
                  value={selectedAppId}
                  onChange={(e) => setSelectedAppId(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                >
                  <option value="">Choose an application...</option>
                  {getAvailableApps().map((app) => (
                    <option key={app.id} value={app.id}>
                      {app.name} (v{app.version})
                    </option>
                  ))}
                </select>
                {getAvailableApps().length === 0 && (
                  <p className="text-sm text-amber-600 dark:text-amber-400 mt-2">
                    No applications available to add
                  </p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Expiration Date (Optional)
                </label>
                <input
                  type="date"
                  value={validTo}
                  onChange={(e) => setValidTo(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                />
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Leave empty for no expiration
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 mt-6">
              <button
                onClick={() => {
                  setShowAddModal(false);
                  setSelectedAppId('');
                  setValidTo('');
                }}
                className="px-4 py-2 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAddEntitlement}
                disabled={!selectedAppId}
                className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

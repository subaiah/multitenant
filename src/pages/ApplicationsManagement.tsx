import { useState, useEffect } from 'react';
import { Package, Plus, Edit2, Trash2, Key, CheckCircle, XCircle } from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api-client';

interface Application {
  id: string;
  key: string;
  name: string;
  description?: string;
  version: string;
  status: string;
  createdAt: string;
  _count?: {
    permissions: number;
    tenantApplications: number;
  };
}

interface Permission {
  id: string;
  name: string;
  description?: string;
  resource: string;
  action: string;
}

export default function ApplicationsManagement() {
  const [applications, setApplications] = useState<Application[]>([]);
  const [selectedApp, setSelectedApp] = useState<Application | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showPermissionModal, setShowPermissionModal] = useState(false);
  const [formData, setFormData] = useState({
    key: '',
    name: '',
    description: '',
    version: '1.0.0',
  });
  const [permissionData, setPermissionData] = useState({
    name: '',
    description: '',
    resource: '',
    action: 'read',
  });

  useEffect(() => {
    fetchApplications();
  }, []);

  useEffect(() => {
    if (selectedApp) {
      fetchPermissions(selectedApp.id);
    }
  }, [selectedApp]);

  const fetchApplications = async () => {
    try {
      const response = await apiGet<any>('/applications');
      setApplications(response.applications);
      if (response.applications.length > 0 && !selectedApp) {
        setSelectedApp(response.applications[0]);
      }
    } catch (error) {
      console.error('Failed to fetch applications:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchPermissions = async (appId: string) => {
    try {
      const response = await apiGet<any>(`/applications/${appId}/permissions`);
      setPermissions(response.permissions);
    } catch (error) {
      console.error('Failed to fetch permissions:', error);
    }
  };

  const handleCreateApp = async () => {
    try {
      await apiPost('/applications', formData);
      setShowCreateModal(false);
      setFormData({ key: '', name: '', description: '', version: '1.0.0' });
      fetchApplications();
    } catch (error) {
      console.error('Failed to create application:', error);
      alert('Failed to create application');
    }
  };

  const handleUpdateApp = async () => {
    if (!selectedApp) return;
    try {
      await apiPatch(`/applications/${selectedApp.id}`, formData);
      setShowEditModal(false);
      setFormData({ key: '', name: '', description: '', version: '1.0.0' });
      fetchApplications();
    } catch (error) {
      console.error('Failed to update application:', error);
      alert('Failed to update application');
    }
  };

  const handleDeleteApp = async (appId: string) => {
    if (!confirm('Are you sure you want to delete this application?')) return;
    try {
      await apiDelete(`/applications/${appId}`);
      if (selectedApp?.id === appId) {
        setSelectedApp(null);
      }
      fetchApplications();
    } catch (error) {
      console.error('Failed to delete application:', error);
      alert('Failed to delete application');
    }
  };

  const handleCreatePermission = async () => {
    if (!selectedApp) return;
    try {
      await apiPost(`/applications/${selectedApp.id}/permissions`, permissionData);
      setShowPermissionModal(false);
      setPermissionData({ name: '', description: '', resource: '', action: 'read' });
      fetchPermissions(selectedApp.id);
    } catch (error) {
      console.error('Failed to create permission:', error);
      alert('Failed to create permission');
    }
  };

  const handleDeletePermission = async (permissionId: string) => {
    if (!confirm('Are you sure you want to delete this permission?')) return;
    try {
      await apiDelete(`/applications/permissions/${permissionId}`);
      if (selectedApp) {
        fetchPermissions(selectedApp.id);
      }
    } catch (error) {
      console.error('Failed to delete permission:', error);
      alert('Failed to delete permission');
    }
  };

  const openEditModal = (app: Application) => {
    setSelectedApp(app);
    setFormData({
      key: app.key,
      name: app.name,
      description: app.description || '',
      version: app.version,
    });
    setShowEditModal(true);
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
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Applications</h1>
        <p className="text-slate-600 dark:text-slate-400 mt-1">
          Manage applications and their permissions
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Applications List */}
        <div className="lg:col-span-1">
          <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
            <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Applications</h2>
              <button
                onClick={() => setShowCreateModal(true)}
                className="p-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
              >
                <Plus size={20} />
              </button>
            </div>
            <div className="divide-y divide-slate-200 dark:divide-slate-700">
              {applications.map((app) => (
                <div
                  key={app.id}
                  onClick={() => setSelectedApp(app)}
                  className={`p-4 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors ${
                    selectedApp?.id === app.id ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-slate-900 dark:text-white">{app.name}</h3>
                        <span
                          className={`px-2 py-0.5 text-xs rounded ${
                            app.status === 'ACTIVE'
                              ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                              : app.status === 'INACTIVE'
                              ? 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300'
                              : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
                          }`}
                        >
                          {app.status}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-mono">
                        {app.key}
                      </p>
                      {app.description && (
                        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                          {app.description}
                        </p>
                      )}
                      <div className="flex items-center gap-4 mt-2 text-xs text-slate-500 dark:text-slate-400">
                        <span className="flex items-center gap-1">
                          <Key size={12} />
                          {app._count?.permissions || 0} permissions
                        </span>
                        <span className="flex items-center gap-1">
                          <Package size={12} />
                          v{app.version}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditModal(app);
                        }}
                        className="p-1 text-slate-400 hover:text-blue-500 transition-colors"
                      >
                        <Edit2 size={16} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteApp(app.id);
                        }}
                        className="p-1 text-slate-400 hover:text-red-500 transition-colors"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              {applications.length === 0 && (
                <div className="p-8 text-center text-slate-500 dark:text-slate-400">
                  No applications yet
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Permissions List */}
        <div className="lg:col-span-2">
          {selectedApp ? (
            <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
              <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                    {selectedApp.name} - Permissions
                  </h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                    Define granular permissions for this application
                  </p>
                </div>
                <button
                  onClick={() => setShowPermissionModal(true)}
                  className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors flex items-center gap-2"
                >
                  <Plus size={20} />
                  Add Permission
                </button>
              </div>
              <div className="p-4">
                {permissions.length > 0 ? (
                  <div className="space-y-2">
                    {permissions.map((perm) => (
                      <div
                        key={perm.id}
                        className="p-4 bg-slate-50 dark:bg-slate-700/50 rounded-lg border border-slate-200 dark:border-slate-600"
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <Key size={16} className="text-blue-500" />
                              <h3 className="font-medium text-slate-900 dark:text-white font-mono">
                                {perm.name}
                              </h3>
                            </div>
                            {perm.description && (
                              <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                                {perm.description}
                              </p>
                            )}
                            <div className="flex items-center gap-4 mt-2 text-xs text-slate-500 dark:text-slate-400">
                              <span>Resource: {perm.resource}</span>
                              <span>Action: {perm.action}</span>
                            </div>
                          </div>
                          <button
                            onClick={() => handleDeletePermission(perm.id)}
                            className="p-1 text-slate-400 hover:text-red-500 transition-colors"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-12 text-slate-500 dark:text-slate-400">
                    No permissions yet. Click "Add Permission" to create one.
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-12 text-center">
              <Package className="mx-auto text-slate-400 mb-4" size={48} />
              <p className="text-slate-600 dark:text-slate-400">
                Select an application to view its permissions
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Create Application Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-slate-800 rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-4">
              Create Application
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Key (unique identifier)
                </label>
                <input
                  type="text"
                  value={formData.key}
                  onChange={(e) => setFormData({ ...formData, key: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white font-mono"
                  placeholder="my-app"
                />
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Lowercase letters, numbers, and hyphens only
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Name
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                  placeholder="Application name"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Version
                </label>
                <input
                  type="text"
                  value={formData.version}
                  onChange={(e) => setFormData({ ...formData, version: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                  placeholder="1.0.0"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Description
                </label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                  placeholder="Application description"
                  rows={3}
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 mt-6">
              <button
                onClick={() => {
                  setShowCreateModal(false);
                  setFormData({ key: '', name: '', description: '', version: '1.0.0' });
                }}
                className="px-4 py-2 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateApp}
                disabled={!formData.key || !formData.name}
                className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Application Modal */}
      {showEditModal && selectedApp && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-slate-800 rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-4">
              Edit Application
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Name
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Version
                </label>
                <input
                  type="text"
                  value={formData.version}
                  onChange={(e) => setFormData({ ...formData, version: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Description
                </label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                  rows={3}
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 mt-6">
              <button
                onClick={() => {
                  setShowEditModal(false);
                  setFormData({ key: '', name: '', description: '', version: '1.0.0' });
                }}
                className="px-4 py-2 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleUpdateApp}
                disabled={!formData.name}
                className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Update
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Permission Modal */}
      {showPermissionModal && selectedApp && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-slate-800 rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-4">
              Add Permission
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Permission Name
                </label>
                <input
                  type="text"
                  value={permissionData.name}
                  onChange={(e) => setPermissionData({ ...permissionData, name: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white font-mono"
                  placeholder={`${selectedApp.key}.resource.action`}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Resource
                </label>
                <input
                  type="text"
                  value={permissionData.resource}
                  onChange={(e) => setPermissionData({ ...permissionData, resource: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                  placeholder="e.g., users, projects, settings"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Action
                </label>
                <select
                  value={permissionData.action}
                  onChange={(e) => setPermissionData({ ...permissionData, action: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                >
                  <option value="read">Read</option>
                  <option value="write">Write</option>
                  <option value="create">Create</option>
                  <option value="update">Update</option>
                  <option value="delete">Delete</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Description
                </label>
                <textarea
                  value={permissionData.description}
                  onChange={(e) => setPermissionData({ ...permissionData, description: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                  placeholder="Permission description"
                  rows={3}
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 mt-6">
              <button
                onClick={() => {
                  setShowPermissionModal(false);
                  setPermissionData({ name: '', description: '', resource: '', action: 'read' });
                }}
                className="px-4 py-2 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreatePermission}
                disabled={!permissionData.name || !permissionData.resource}
                className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

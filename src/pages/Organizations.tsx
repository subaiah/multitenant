import { useState } from 'react';
import { Building2, Plus, Edit2, Trash2, Users, ChevronRight } from 'lucide-react';
import { apiPost, apiPatch, apiDelete } from '../lib/api-client';
import { useApi } from '../hooks/useApi';
import { invalidateApi } from '../lib/query';
import { PermissionButton } from '../components/PermissionGuard';

interface Organization {
  id: string;
  name: string;
  description?: string;
  status: string;
  createdAt: string;
  _count?: {
    units: number;
    memberships: number;
  };
  /** ORGANIZATION: a role for all of it (or the tenant); UNITS: only for some of its units */
  access?: 'ORGANIZATION' | 'UNITS';
  /** What the signed-in user may do with it (roles can be given for one organization) */
  can?: { update: boolean; delete: boolean };
}

interface OrgUnit {
  id: string;
  name: string;
  unitType: string;
  description?: string;
  parentUnitId?: string;
  _count?: {
    children: number;
    memberships: number;
  };
}

export default function Organizations() {
  const list = useApi<{ organizations: Organization[] }>('/organizations');
  const organizations = list.data?.organizations ?? [];
  const loading = list.loading;
  // The chosen organization, read from the latest list (the first by default)
  const [selectedId, setSelectedId] = useState<string | null | undefined>(undefined);
  const selectedOrg = (selectedId === undefined ? organizations[0] : organizations.find((o) => o.id === selectedId)) ?? null;
  const setSelectedOrg = (org: Organization | null) => setSelectedId(org?.id ?? null);
  const orgUnits = useApi<{ units: OrgUnit[] }>(selectedOrg ? `/org-units/organization/${selectedOrg.id}` : null).data?.units ?? [];
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showUnitModal, setShowUnitModal] = useState(false);
  const [formData, setFormData] = useState({ name: '', description: '' });
  const [unitFormData, setUnitFormData] = useState({
    name: '',
    description: '',
    unitType: 'DEPARTMENT',
    parentUnitId: '',
  });

  // After a change: organizations (and their member counts) and units, wherever they're shown
  const fetchOrganizations = () => invalidateApi('/organizations', '/org-units');
  const fetchOrgUnits = (_orgId: string) => invalidateApi('/org-units', '/organizations');

  const handleCreateOrg = async () => {
    try {
      await apiPost('/organizations', formData);
      setShowCreateModal(false);
      setFormData({ name: '', description: '' });
      fetchOrganizations();
    } catch (error) {
      console.error('Failed to create organization:', error);
      alert('Failed to create organization');
    }
  };

  const handleUpdateOrg = async () => {
    if (!selectedOrg) return;
    try {
      await apiPatch(`/organizations/${selectedOrg.id}`, formData);
      setShowEditModal(false);
      setFormData({ name: '', description: '' });
      fetchOrganizations();
    } catch (error) {
      console.error('Failed to update organization:', error);
      alert('Failed to update organization');
    }
  };

  const handleDeleteOrg = async (orgId: string) => {
    if (!confirm('Are you sure you want to delete this organization?')) return;
    try {
      await apiDelete(`/organizations/${orgId}`);
      if (selectedOrg?.id === orgId) {
        setSelectedOrg(null);
      }
      fetchOrganizations();
    } catch (error) {
      console.error('Failed to delete organization:', error);
      alert('Failed to delete organization');
    }
  };

  const handleCreateUnit = async () => {
    if (!selectedOrg) return;
    try {
      await apiPost(`/org-units/organization/${selectedOrg.id}`, unitFormData);
      setShowUnitModal(false);
      setUnitFormData({ name: '', description: '', unitType: 'DEPARTMENT', parentUnitId: '' });
      fetchOrgUnits(selectedOrg.id);
    } catch (error) {
      console.error('Failed to create org unit:', error);
      alert('Failed to create org unit');
    }
  };

  const handleDeleteUnit = async (unitId: string) => {
    if (!confirm('Are you sure you want to delete this unit?')) return;
    if (!selectedOrg) return;
    try {
      await apiDelete(`/org-units/${unitId}`);
      fetchOrgUnits(selectedOrg.id);
    } catch (error) {
      console.error('Failed to delete org unit:', error);
      alert('Failed to delete org unit');
    }
  };

  const openEditModal = (org: Organization) => {
    setSelectedOrg(org);
    setFormData({ name: org.name, description: org.description || '' });
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
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-white">Organizations</h1>
        <p className="text-slate-600 dark:text-slate-400 mt-1">
          Manage organizational structure and hierarchy
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Organizations List */}
        <div className="lg:col-span-1">
          <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
            <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Organizations</h2>
              <PermissionButton
                permission="organizations:create"
                onClick={() => setShowCreateModal(true)}
                className="p-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
              >
                <Plus size={20} />
              </PermissionButton>
            </div>
            <div className="divide-y divide-slate-200 dark:divide-slate-700">
              {organizations.map((org) => (
                <div
                  key={org.id}
                  onClick={() => setSelectedOrg(org)}
                  className={`p-4 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors ${
                    selectedOrg?.id === org.id ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <h3 className="font-medium text-slate-900 dark:text-white">{org.name}</h3>
                      {org.description && (
                        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                          {org.description}
                        </p>
                      )}
                      <div className="flex items-center gap-4 mt-2 text-xs text-slate-500 dark:text-slate-400">
                        <span className="flex items-center gap-1">
                          <Building2 size={12} />
                          {org._count?.units || 0} units
                        </span>
                        <span className="flex items-center gap-1">
                          <Users size={12} />
                          {org._count?.memberships || 0} members
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {org.can?.update && (
                        <button
                          aria-label={`Edit ${org.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditModal(org);
                          }}
                          className="p-1 text-slate-400 hover:text-blue-500 transition-colors"
                        >
                          <Edit2 size={16} />
                        </button>
                      )}
                      {org.can?.delete && (
                        <button
                          aria-label={`Delete ${org.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteOrg(org.id);
                          }}
                          className="p-1 text-slate-400 hover:text-red-500 transition-colors"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {organizations.length === 0 && (
                <div className="p-8 text-center text-slate-500 dark:text-slate-400">
                  No organizations yet
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Org Units Tree */}
        <div className="lg:col-span-2">
          {selectedOrg ? (
            <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
              <div className="p-4 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
                    {selectedOrg.name} - Organizational Units
                  </h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                    {selectedOrg.access === 'UNITS'
                      ? 'Your roles cover some of its units: those are the ones shown'
                      : 'Manage departments, teams, and locations'}
                  </p>
                </div>
                {selectedOrg.can?.update && (
                  <button
                    onClick={() => setShowUnitModal(true)}
                    className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors flex items-center gap-2"
                  >
                    <Plus size={20} />
                    Add Unit
                  </button>
                )}
              </div>
              <div className="p-4">
                {orgUnits.length > 0 ? (
                  <div className="space-y-2">
                    {orgUnits.map((unit) => (
                      <div
                        key={unit.id}
                        className="p-4 bg-slate-50 dark:bg-slate-700/50 rounded-lg border border-slate-200 dark:border-slate-600"
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <span className="px-2 py-1 text-xs font-medium bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded">
                                {unit.unitType}
                              </span>
                              <h3 className="font-medium text-slate-900 dark:text-white">
                                {unit.name}
                              </h3>
                            </div>
                            {unit.description && (
                              <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                                {unit.description}
                              </p>
                            )}
                            <div className="flex items-center gap-4 mt-2 text-xs text-slate-500 dark:text-slate-400">
                              {unit._count?.children ? (
                                <span className="flex items-center gap-1">
                                  <ChevronRight size={12} />
                                  {unit._count.children} sub-units
                                </span>
                              ) : null}
                              <span className="flex items-center gap-1">
                                <Users size={12} />
                                {unit._count?.memberships || 0} members
                              </span>
                            </div>
                          </div>
                          {/* Removing a unit changes the organization (the server checks the unit's own scope too) */}
                          {selectedOrg.can?.update && (
                            <button
                              aria-label={`Delete ${unit.name}`}
                              onClick={() => handleDeleteUnit(unit.id)}
                              className="p-1 text-slate-400 hover:text-red-500 transition-colors"
                            >
                              <Trash2 size={16} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-12 text-slate-500 dark:text-slate-400">
                    No organizational units yet. Click "Add Unit" to create one.
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-12 text-center">
              <Building2 className="mx-auto text-slate-400 mb-4" size={48} />
              <p className="text-slate-600 dark:text-slate-400">
                Select an organization to view its structure
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Create Organization Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-slate-800 rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-semibold text-slate-900 dark:text-white mb-4">
              Create Organization
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
                  placeholder="Organization name"
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
                  placeholder="Organization description"
                  rows={3}
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 mt-6">
              <button
                onClick={() => {
                  setShowCreateModal(false);
                  setFormData({ name: '', description: '' });
                }}
                className="px-4 py-2 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateOrg}
                disabled={!formData.name}
                className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Organization Modal */}
      {showEditModal && selectedOrg && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-slate-800 rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-semibold text-slate-900 dark:text-white mb-4">
              Edit Organization
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
                  setFormData({ name: '', description: '' });
                }}
                className="px-4 py-2 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleUpdateOrg}
                disabled={!formData.name}
                className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Update
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create Org Unit Modal */}
      {showUnitModal && selectedOrg && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-slate-800 rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-semibold text-slate-900 dark:text-white mb-4">
              Add Organizational Unit
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Name
                </label>
                <input
                  type="text"
                  value={unitFormData.name}
                  onChange={(e) => setUnitFormData({ ...unitFormData, name: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                  placeholder="Unit name"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Type
                </label>
                <select
                  value={unitFormData.unitType}
                  onChange={(e) => setUnitFormData({ ...unitFormData, unitType: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                >
                  <option value="DIVISION">Division</option>
                  <option value="DEPARTMENT">Department</option>
                  <option value="TEAM">Team</option>
                  <option value="LOCATION">Location</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Parent Unit (Optional)
                </label>
                <select
                  value={unitFormData.parentUnitId}
                  onChange={(e) => setUnitFormData({ ...unitFormData, parentUnitId: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                >
                  <option value="">None (Top level)</option>
                  {orgUnits.map((unit) => (
                    <option key={unit.id} value={unit.id}>
                      {unit.name} ({unit.unitType})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Description
                </label>
                <textarea
                  value={unitFormData.description}
                  onChange={(e) => setUnitFormData({ ...unitFormData, description: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                  placeholder="Unit description"
                  rows={3}
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 mt-6">
              <button
                onClick={() => {
                  setShowUnitModal(false);
                  setUnitFormData({ name: '', description: '', unitType: 'DEPARTMENT', parentUnitId: '' });
                }}
                className="px-4 py-2 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateUnit}
                disabled={!unitFormData.name}
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

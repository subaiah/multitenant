import { useAuth } from '../contexts/AuthContext';
import { useState, useEffect } from 'react';
import { Shield, Plus, Trash2, Calendar, Users, User, Building2, MapPin, Package } from 'lucide-react';
import { apiGet, apiPost, apiRequest } from '../lib/api-client';

interface Role {
  id: string;
  name: string;
  description?: string;
  permissions: string[];
}

interface RoleAssignment {
  id: string;
  roleId: string;
  roleName: string;
  principalType: 'USER' | 'GROUP';
  userId?: string;
  groupId?: string;
  principalName: string;
  scopeType: 'TENANT' | 'ORGANIZATION' | 'ORG_UNIT' | 'RESOURCE';
  scopeId: string;
  scopeName: string;
  validFrom: string;
  validTo?: string;
  status: string;
  permissions?: string[];
}

interface User {
  id: string;
  email: string;
  name?: string;
}

interface Group {
  id: string;
  name: string;
}

export default function RoleAssignments() {
  const [assignments, setAssignments] = useState<RoleAssignment[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const canAssign = useAuth().hasPermission('roles:assign');
  const [users, setUsers] = useState<User[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [formData, setFormData] = useState({
    roleId: '',
    principalType: 'USER' as 'USER' | 'GROUP',
    userId: '',
    groupId: '',
    scopeType: 'TENANT' as 'TENANT' | 'ORGANIZATION' | 'ORG_UNIT' | 'RESOURCE',
    scopeId: '',
    validFrom: '',
    validTo: '',
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [assignmentsRes, rolesRes, usersRes, groupsRes] = await Promise.all([
        apiGet('/roles/assignments'),
        apiGet('/roles'),
        apiGet('/users'),
        apiGet('/groups'),
      ]);
      setAssignments(assignmentsRes.assignments || []);
      setRoles(rolesRes.roles || []);
      setUsers(usersRes.data || []); // GET /users returns { data, pagination }
      setGroups(groupsRes.groups || []);
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateAssignment = async () => {
    try {
      const payload: any = {
        roleId: formData.roleId,
        principalType: formData.principalType,
        scopeType: formData.scopeType,
        scopeId: formData.scopeId,
      };

      if (formData.principalType === 'USER') {
        payload.userId = formData.userId;
      } else {
        payload.groupId = formData.groupId;
      }

      if (formData.validFrom) {
        payload.validFrom = new Date(formData.validFrom).toISOString();
      }
      if (formData.validTo) {
        payload.validTo = new Date(formData.validTo).toISOString();
      }

      await apiPost('/roles/assign', payload);
      setShowCreateModal(false);
      resetForm();
      fetchData();
    } catch (error) {
      console.error('Failed to create assignment:', error);
      alert('Failed to create assignment');
    }
  };

  const handleDeleteAssignment = async (assignmentId: string) => {
    if (!confirm('Are you sure you want to delete this assignment?')) return;
    try {
      await apiRequest('/roles/unassign', { method: 'DELETE', body: JSON.stringify({ assignmentId }) });
      fetchData();
    } catch (error) {
      console.error('Failed to delete assignment:', error);
      alert('Failed to delete assignment');
    }
  };

  const resetForm = () => {
    setFormData({
      roleId: '',
      principalType: 'USER',
      userId: '',
      groupId: '',
      scopeType: 'TENANT',
      scopeId: '',
      validFrom: '',
      validTo: '',
    });
  };

  const getScopeIcon = (scopeType: string) => {
    switch (scopeType) {
      case 'TENANT':
        return <Building2 size={16} className="text-blue-500" />;
      case 'ORGANIZATION':
        return <Users size={16} className="text-purple-500" />;
      case 'ORG_UNIT':
        return <MapPin size={16} className="text-green-500" />;
      case 'RESOURCE':
        return <Package size={16} className="text-orange-500" />;
      default:
        return <Building2 size={16} className="text-slate-500" />;
    }
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
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Role Assignments</h1>
        <p className="text-slate-600 dark:text-slate-400 mt-1">
          Manage role assignments with scope-based access control
        </p>
      </div>

      {/* Actions Bar */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
            <Shield size={16} />
            <span>{assignments.length} active assignments</span>
          </div>
        </div>
        {canAssign && (
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
          >
            <Plus size={20} />
            New Assignment
          </button>
        )}
      </div>

      {/* Assignments Table */}
      <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Role
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Principal
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Scope
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Validity
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
              {assignments.map((assignment) => (
                <tr key={assignment.id} className="hover:bg-slate-50 dark:hover:bg-slate-700/50">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-blue-100 dark:bg-blue-900 rounded-lg">
                        <Shield className="text-blue-600 dark:text-blue-400" size={20} />
                      </div>
                      <div>
                        <p className="font-medium text-slate-900 dark:text-white">
                          {assignment.roleName}
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          {assignment.permissions?.length || 0} permissions
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      {assignment.principalType === 'USER' ? (
                        <User size={16} className="text-slate-400" />
                      ) : (
                        <Users size={16} className="text-slate-400" />
                      )}
                      <div>
                        <p className="text-sm font-medium text-slate-900 dark:text-white">
                          {assignment.principalName}
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          {assignment.principalType}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      {getScopeIcon(assignment.scopeType)}
                      <div>
                        <p className="text-sm font-medium text-slate-900 dark:text-white">
                          {assignment.scopeName}
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          {assignment.scopeType}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2 text-sm">
                      <Calendar size={14} className="text-slate-400" />
                      <div>
                        <p className="text-slate-900 dark:text-white">
                          {formatDate(assignment.validFrom)}
                        </p>
                        {assignment.validTo && (
                          <p className="text-xs text-slate-500 dark:text-slate-400">
                            to {formatDate(assignment.validTo)}
                          </p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    {isExpired(assignment.validTo) ? (
                      <span className="px-2 py-1 text-xs rounded-full bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300">
                        Expired
                      </span>
                    ) : (
                      <span className="px-2 py-1 text-xs rounded-full bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">
                        Active
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right">
                    {canAssign && <button
                      onClick={() => handleDeleteAssignment(assignment.id)}
                      className="p-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900 rounded-lg transition-colors"
                      title="Delete Assignment"
                    >
                      <Trash2 size={18} />
                    </button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {assignments.length === 0 && (
          <div className="text-center py-12">
            <Shield className="mx-auto text-slate-400 mb-4" size={48} />
            <p className="text-slate-600 dark:text-slate-400">
              No role assignments yet. Create your first assignment!
            </p>
          </div>
        )}
      </div>

      {/* Create Assignment Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-slate-800 rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-4">
              Create Role Assignment
            </h2>
            <div className="space-y-4">
              {/* Role Selection */}
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Role
                </label>
                <select
                  value={formData.roleId}
                  onChange={(e) => setFormData({ ...formData, roleId: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                >
                  <option value="">Select a role</option>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Principal Type */}
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Assign To
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, principalType: 'USER', groupId: '' })}
                    className={`flex-1 px-4 py-2 rounded-lg border transition-colors ${
                      formData.principalType === 'USER'
                        ? 'bg-blue-500 text-white border-blue-500'
                        : 'bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-600'
                    }`}
                  >
                    <User size={16} className="inline mr-2" />
                    User
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormData({ ...formData, principalType: 'GROUP', userId: '' })}
                    className={`flex-1 px-4 py-2 rounded-lg border transition-colors ${
                      formData.principalType === 'GROUP'
                        ? 'bg-blue-500 text-white border-blue-500'
                        : 'bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-600'
                    }`}
                  >
                    <Users size={16} className="inline mr-2" />
                    Group
                  </button>
                </div>
              </div>

              {/* User/Group Selection */}
              {formData.principalType === 'USER' ? (
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                    User
                  </label>
                  <select
                    value={formData.userId}
                    onChange={(e) => setFormData({ ...formData, userId: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                  >
                    <option value="">Select a user</option>
                    {users.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name || user.email}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Group
                  </label>
                  <select
                    value={formData.groupId}
                    onChange={(e) => setFormData({ ...formData, groupId: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                  >
                    <option value="">Select a group</option>
                    {groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Scope Type */}
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Scope Type
                </label>
                <select
                  value={formData.scopeType}
                  onChange={(e) => setFormData({ ...formData, scopeType: e.target.value as any })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                >
                  <option value="TENANT">Tenant</option>
                  <option value="ORGANIZATION">Organization (Phase 2)</option>
                  <option value="ORG_UNIT">Organizational Unit (Phase 2)</option>
                  <option value="RESOURCE">Resource (Phase 2)</option>
                </select>
                {formData.scopeType !== 'TENANT' && (
                  <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                    Note: Organization, Org Unit, and Resource scopes will be available in Phase 2
                  </p>
                )}
              </div>

              {/* Scope ID */}
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Scope ID
                </label>
                <input
                  type="text"
                  value={formData.scopeId}
                  onChange={(e) => setFormData({ ...formData, scopeId: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                  placeholder="Enter scope ID (e.g., tenant ID)"
                />
              </div>

              {/* Validity Period */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Valid From
                  </label>
                  <input
                    type="datetime-local"
                    value={formData.validFrom}
                    onChange={(e) => setFormData({ ...formData, validFrom: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Valid To (Optional)
                  </label>
                  <input
                    type="datetime-local"
                    value={formData.validTo}
                    onChange={(e) => setFormData({ ...formData, validTo: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 mt-6">
              <button
                onClick={() => {
                  setShowCreateModal(false);
                  resetForm();
                }}
                className="px-4 py-2 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateAssignment}
                disabled={!formData.roleId || !formData.scopeId || (formData.principalType === 'USER' ? !formData.userId : !formData.groupId)}
                className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Create Assignment
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

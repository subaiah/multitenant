import { useState, useEffect } from 'react';
import { Users, Plus, Edit2, Trash2, UserPlus, UserMinus, Search, X } from 'lucide-react';
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api-client';
import { PermissionButton } from '../components/PermissionGuard';

interface Group {
  id: string;
  name: string;
  description?: string;
  groupType: 'MANUAL' | 'SYNCED' | 'RULE_BASED';
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
  _count?: {
    members: number;
  };
}

interface GroupMember {
  id: string;
  user: {
    id: string;
    email: string;
    name?: string;
    userType: string;
  };
}

interface User {
  id: string;
  email: string;
  name?: string;
  userType: string;
}

export default function Groups() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showMembersModal, setShowMembersModal] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([]);
  const [availableUsers, setAvailableUsers] = useState<User[]>([]);
  const [formData, setFormData] = useState<{
    name: string;
    description: string;
    groupType: 'MANUAL' | 'SYNCED' | 'RULE_BASED';
  }>({
    name: '',
    description: '',
    groupType: 'MANUAL',
  });

  useEffect(() => {
    fetchGroups();
  }, []);

  const fetchGroups = async () => {
    try {
      const response = await apiGet('/groups');
      setGroups(response.groups);
    } catch (error) {
      console.error('Failed to fetch groups:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchGroupMembers = async (groupId: string) => {
    try {
      const response = await apiGet(`/groups/${groupId}`);
      setGroupMembers(response.members || []);
    } catch (error) {
      console.error('Failed to fetch group members:', error);
    }
  };

  const fetchAvailableUsers = async () => {
    try {
      const response = await apiGet('/users');
      setAvailableUsers(response.users || []);
    } catch (error) {
      console.error('Failed to fetch users:', error);
    }
  };

  const handleCreateGroup = async () => {
    try {
      await apiPost('/groups', formData);
      setShowCreateModal(false);
      setFormData({ name: '', description: '', groupType: 'MANUAL' as const });
      fetchGroups();
    } catch (error) {
      console.error('Failed to create group:', error);
      alert('Failed to create group');
    }
  };

  const handleUpdateGroup = async () => {
    if (!selectedGroup) return;
    try {
      await apiPatch(`/groups/${selectedGroup.id}`, formData);
      setShowEditModal(false);
      setFormData({ name: '', description: '', groupType: 'MANUAL' as const });
      setSelectedGroup(null);
      fetchGroups();
    } catch (error) {
      console.error('Failed to update group:', error);
      alert('Failed to update group');
    }
  };

  const handleDeleteGroup = async (groupId: string) => {
    if (!confirm('Are you sure you want to delete this group?')) return;
    try {
      await apiDelete(`/groups/${groupId}`);
      fetchGroups();
    } catch (error) {
      console.error('Failed to delete group:', error);
      alert('Failed to delete group');
    }
  };

  const handleAddMember = async (userId: string) => {
    if (!selectedGroup) return;
    try {
      await apiPost(`/groups/${selectedGroup.id}/members`, { userId });
      fetchGroupMembers(selectedGroup.id);
      fetchGroups();
    } catch (error) {
      console.error('Failed to add member:', error);
      alert('Failed to add member');
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!selectedGroup) return;
    try {
      await apiDelete(`/groups/${selectedGroup.id}/members/${userId}`);
      fetchGroupMembers(selectedGroup.id);
      fetchGroups();
    } catch (error) {
      console.error('Failed to remove member:', error);
      alert('Failed to remove member');
    }
  };

  const openEditModal = (group: Group) => {
    setSelectedGroup(group);
    setFormData({
      name: group.name,
      description: group.description || '',
      groupType: group.groupType,
    });
    setShowEditModal(true);
  };

  const openMembersModal = async (group: Group) => {
    setSelectedGroup(group);
    await fetchGroupMembers(group.id);
    await fetchAvailableUsers();
    setShowMembersModal(true);
  };

  const filteredGroups = groups.filter(group =>
    group.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    group.description?.toLowerCase().includes(searchTerm.toLowerCase())
  );

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
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">Groups</h1>
        <p className="text-slate-600 dark:text-slate-400 mt-1">
          Manage user groups and team memberships
        </p>
      </div>

      {/* Actions Bar */}
      <div className="mb-6 flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400" size={20} />
          <input
            type="text"
            placeholder="Search groups..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
          />
        </div>
        <PermissionButton
          permission="groups:create"
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
        >
          <Plus size={20} />
          Create Group
        </PermissionButton>
      </div>

      {/* Groups Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredGroups.map((group) => (
          <div
            key={group.id}
            className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg p-6 hover:shadow-lg transition-shadow"
          >
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 dark:bg-blue-900 rounded-lg">
                  <Users className="text-blue-600 dark:text-blue-400" size={24} />
                </div>
                <div>
                  <h3 className="font-semibold text-slate-900 dark:text-white">{group.name}</h3>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {group._count?.members || 0} members
                  </span>
                </div>
              </div>
              <span
                className={`px-2 py-1 text-xs rounded-full ${
                  group.status === 'ACTIVE'
                    ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                    : 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300'
                }`}
              >
                {group.status}
              </span>
            </div>

            {group.description && (
              <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
                {group.description}
              </p>
            )}

            <div className="flex items-center justify-between pt-4 border-t border-slate-200 dark:border-slate-700">
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Type: {group.groupType}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => openMembersModal(group)}
                  className="p-2 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900 rounded-lg transition-colors"
                  title="Manage Members"
                >
                  <UserPlus size={18} />
                </button>
                <PermissionButton
                  permission="groups:update"
                  onClick={() => openEditModal(group)}
                  className="p-2 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
                  title="Edit Group"
                >
                  <Edit2 size={18} />
                </PermissionButton>
                <PermissionButton
                  permission="groups:delete"
                  onClick={() => handleDeleteGroup(group.id)}
                  className="p-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900 rounded-lg transition-colors"
                  title="Delete Group"
                >
                  <Trash2 size={18} />
                </PermissionButton>
              </div>
            </div>
          </div>
        ))}
      </div>

      {filteredGroups.length === 0 && (
        <div className="text-center py-12">
          <Users className="mx-auto text-slate-400 mb-4" size={48} />
          <p className="text-slate-600 dark:text-slate-400">
            {searchTerm ? 'No groups found matching your search' : 'No groups yet. Create your first group!'}
          </p>
        </div>
      )}

      {/* Create Group Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-slate-800 rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-4">Create Group</h2>
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
                  placeholder="Group name"
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
                  placeholder="Group description"
                  rows={3}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Type
                </label>
                <select
                  value={formData.groupType}
                  onChange={(e) => setFormData({ ...formData, groupType: e.target.value as any })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                >
                  <option value="MANUAL">Manual</option>
                  <option value="SYNCED">Synced</option>
                  <option value="RULE_BASED">Rule Based</option>
                </select>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 mt-6">
              <button
                onClick={() => {
                  setShowCreateModal(false);
                  setFormData({ name: '', description: '', groupType: 'MANUAL' as const });
                }}
                className="px-4 py-2 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateGroup}
                disabled={!formData.name}
                className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Group Modal */}
      {showEditModal && selectedGroup && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-slate-800 rounded-lg p-6 w-full max-w-md">
            <h2 className="text-xl font-bold text-slate-900 dark:text-white mb-4">Edit Group</h2>
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
                  setSelectedGroup(null);
                  setFormData({ name: '', description: '', groupType: 'MANUAL' as const });
                }}
                className="px-4 py-2 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleUpdateGroup}
                disabled={!formData.name}
                className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Update
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Members Modal */}
      {showMembersModal && selectedGroup && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-slate-800 rounded-lg p-6 w-full max-w-2xl max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-slate-900 dark:text-white">
                Members of {selectedGroup.name}
              </h2>
              <button
                onClick={() => {
                  setShowMembersModal(false);
                  setSelectedGroup(null);
                  setGroupMembers([]);
                }}
                className="text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              >
                <X size={24} />
              </button>
            </div>

            {/* Current Members */}
            <div className="mb-6">
              <h3 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                Current Members ({groupMembers.length})
              </h3>
              <div className="space-y-2">
                {groupMembers.map((member) => (
                  <div
                    key={member.id}
                    className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-700 rounded-lg"
                  >
                    <div>
                      <p className="font-medium text-slate-900 dark:text-white">
                        {member.user.name || member.user.email}
                      </p>
                      <p className="text-sm text-slate-500 dark:text-slate-400">
                        {member.user.email}
                      </p>
                    </div>
                    <button
                      onClick={() => handleRemoveMember(member.user.id)}
                      className="p-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900 rounded-lg transition-colors"
                      title="Remove Member"
                    >
                      <UserMinus size={18} />
                    </button>
                  </div>
                ))}
                {groupMembers.length === 0 && (
                  <p className="text-center text-slate-500 dark:text-slate-400 py-4">
                    No members in this group
                  </p>
                )}
              </div>
            </div>

            {/* Add Members */}
            <div>
              <h3 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                Add Members
              </h3>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {availableUsers
                  .filter(user => !groupMembers.some(m => m.user.id === user.id))
                  .map((user) => (
                    <div
                      key={user.id}
                      className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-700 rounded-lg"
                    >
                      <div>
                        <p className="font-medium text-slate-900 dark:text-white">
                          {user.name || user.email}
                        </p>
                        <p className="text-sm text-slate-500 dark:text-slate-400">
                          {user.email}
                        </p>
                      </div>
                      <button
                        onClick={() => handleAddMember(user.id)}
                        className="p-2 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900 rounded-lg transition-colors"
                        title="Add Member"
                      >
                        <UserPlus size={18} />
                      </button>
                    </div>
                  ))}
                {availableUsers.filter(user => !groupMembers.some(m => m.user.id === user.id)).length === 0 && (
                  <p className="text-center text-slate-500 dark:text-slate-400 py-4">
                    All users are already members
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

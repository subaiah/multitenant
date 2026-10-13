import { useState, useEffect } from 'react';
import { User, Mail, Building2, Shield, Calendar, Save, Loader2 } from 'lucide-react';
import { getCurrentUser, apiPatch } from '../lib/api-client';

interface UserInfo {
  id: string;
  email: string;
  name: string | null;
  userType: string;
}

interface TenantInfo {
  id: string;
  name: string;
  slug: string;
}

export default function Profile() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    const fetchUser = async () => {
      try {
        const data = await getCurrentUser();
        setUser(data.user);
        setTenant(data.tenant);
        setName(data.user.name || '');
      } catch (error) {
        console.error('Failed to fetch user:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchUser();
  }, []);

  const handleSave = async () => {
    if (!user) return;

    setSaving(true);
    setMessage(null);

    try {
      await apiPatch(`/users/${user.id}`, { name });
      setUser({ ...user, name });
      setMessage({ type: 'success', text: 'Profile updated successfully' });
    } catch (error) {
      console.error('Failed to update profile:', error);
      setMessage({ type: 'error', text: 'Failed to update profile' });
    } finally {
      setSaving(false);
    }
  };

  const formatUserType = (userType: string) => {
    return userType
      .split('_')
      .map(word => word.charAt(0) + word.slice(1).toLowerCase())
      .join(' ');
  };

  const getUserInitials = () => {
    if (name) {
      return name
        .split(' ')
        .map(n => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2);
    }
    return user?.email?.[0].toUpperCase() || 'U';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="p-6">
        <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg p-4">
          <p className="text-red-800 dark:text-red-300">Failed to load user information</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">Profile</h1>
        <p className="text-slate-600 dark:text-slate-400 mt-1">
          Manage your account information
        </p>
      </div>

      {/* Success/Error message */}
      {message && (
        <div
          className={`mb-6 p-4 rounded-lg border ${
            message.type === 'success'
              ? 'bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/30'
              : 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30'
          }`}
        >
          <p
            className={
              message.type === 'success'
                ? 'text-green-800 dark:text-green-300'
                : 'text-red-800 dark:text-red-300'
            }
          >
            {message.text}
          </p>
        </div>
      )}

      {/* Profile card */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-r from-blue-500 to-purple-600 p-6">
          <div className="flex items-center gap-4">
            <div className="w-20 h-20 bg-white/20 backdrop-blur-sm rounded-full flex items-center justify-center text-white font-bold text-2xl border-2 border-white/30">
              {getUserInitials()}
            </div>
            <div className="text-white">
              <h2 className="text-xl font-bold">{name || user.email}</h2>
              <p className="text-blue-100 text-sm">{formatUserType(user.userType)}</p>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Personal Information */}
          <div>
            <h3 className="text-lg font-semibold text-slate-800 dark:text-white mb-4 flex items-center gap-2">
              <User size={20} className="text-blue-500" />
              Personal Information
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                  Full Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-slate-700 dark:text-slate-200"
                  placeholder="Enter your full name"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                  Email Address
                </label>
                <div className="flex items-center gap-3 px-4 py-2.5 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg">
                  <Mail size={18} className="text-slate-400" />
                  <span className="text-slate-700 dark:text-slate-200">{user.email}</span>
                  <span className="ml-auto text-xs text-slate-400">Cannot be changed</span>
                </div>
              </div>
            </div>
          </div>

          {/* Account Information */}
          <div className="border-t border-slate-200 dark:border-slate-700 pt-6">
            <h3 className="text-lg font-semibold text-slate-800 dark:text-white mb-4 flex items-center gap-2">
              <Shield size={20} className="text-blue-500" />
              Account Information
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700">
                <div className="flex items-center gap-2 mb-2">
                  <User size={16} className="text-slate-400" />
                  <span className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase">
                    User Type
                  </span>
                </div>
                <p className="text-sm font-medium text-slate-800 dark:text-white">
                  {formatUserType(user.userType)}
                </p>
              </div>
              <div className="p-4 bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700">
                <div className="flex items-center gap-2 mb-2">
                  <Building2 size={16} className="text-slate-400" />
                  <span className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase">
                    Tenant
                  </span>
                </div>
                <p className="text-sm font-medium text-slate-800 dark:text-white">
                  {tenant?.name || 'N/A'}
                </p>
              </div>
            </div>
          </div>

          {/* Save button */}
          <div className="flex justify-end pt-4">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  <span>Saving...</span>
                </>
              ) : (
                <>
                  <Save size={16} />
                  <span>Save Changes</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

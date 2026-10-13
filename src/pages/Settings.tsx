import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Settings,
  Globe,
  Shield,
  Bell,
  Palette,
  Database,
  Mail,
  Key,
  Save,
  Check,
} from 'lucide-react';

export default function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'general';
  const [saved, setSaved] = useState(false);

  const setActiveTab = (tab: string) => {
    const newParams = new URLSearchParams(searchParams);
    if (tab === 'general') {
      newParams.delete('tab');
    } else {
      newParams.set('tab', tab);
    }
    setSearchParams(newParams);
  };

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const tabs = [
    { id: 'general', label: 'General', icon: Settings },
    { id: 'appearance', label: 'Appearance', icon: Palette },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'security', label: 'Security', icon: Shield },
    { id: 'integrations', label: 'Integrations', icon: Database },
    { id: 'email', label: 'Email', icon: Mail },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-800 dark:text-white">Settings</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Manage your platform settings and preferences
          </p>
        </div>
        <button
          onClick={handleSave}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-all shadow-sm ${
            saved
              ? 'bg-green-600 text-white'
              : 'bg-blue-600 hover:bg-blue-700 text-white'
          }`}
        >
          {saved ? <Check size={16} /> : <Save size={16} />}
          {saved ? 'Saved!' : 'Save Changes'}
        </button>
      </div>

      <div className="flex gap-6">
        {/* Tabs */}
        <div className="w-56 flex-shrink-0">
          <nav className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-2 space-y-1">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    activeTab === tab.id
                      ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700'
                  }`}
                >
                  <Icon size={16} />
                  {tab.label}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Content */}
        <div className="flex-1">
          <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-6">
            {activeTab === 'general' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-base font-semibold text-slate-800 dark:text-white mb-1">General Settings</h3>
                  <p className="text-sm text-slate-500 dark:text-slate-400">Configure your platform's basic settings</p>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">
                      Platform Name
                    </label>
                    <input
                      type="text"
                      defaultValue="MultiTenant Platform"
                      className="w-full px-4 py-2.5 text-sm bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-slate-700 dark:text-slate-200"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">
                      Platform URL
                    </label>
                    <div className="flex">
                      <span className="inline-flex items-center px-3 py-2.5 text-sm bg-slate-100 dark:bg-slate-600 border border-r-0 border-slate-200 dark:border-slate-600 rounded-l-lg text-slate-500 dark:text-slate-400">
                        <Globe size={14} className="mr-1" />
                        https://
                      </span>
                      <input
                        type="text"
                        defaultValue="app.multitenant.io"
                        className="flex-1 px-4 py-2.5 text-sm bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-r-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-slate-700 dark:text-slate-200"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">
                      Default Tenant Plan
                    </label>
                    <select className="w-full px-4 py-2.5 text-sm bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200">
                      <option>Free</option>
                      <option>Starter</option>
                      <option>Professional</option>
                      <option>Enterprise</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">
                      Max Applications per Tenant
                    </label>
                    <input
                      type="number"
                      defaultValue={20}
                      className="w-full px-4 py-2.5 text-sm bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-slate-700 dark:text-slate-200"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">
                      Maintenance Mode
                    </label>
                    <div className="flex items-center gap-3">
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" />
                        <div className="w-11 h-6 bg-slate-200 dark:bg-slate-600 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-500/20 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                      </label>
                      <span className="text-sm text-slate-500 dark:text-slate-400">Enable maintenance mode for all tenants</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'security' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-base font-semibold text-slate-800 dark:text-white mb-1">Security Settings</h3>
                  <p className="text-sm text-slate-500 dark:text-slate-400">Configure security and authentication options</p>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-700/50 rounded-xl">
                    <div className="flex items-center gap-3">
                      <Key size={18} className="text-slate-500" />
                      <div>
                        <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Two-Factor Authentication</p>
                        <p className="text-xs text-slate-400">Require 2FA for all admin accounts</p>
                      </div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" defaultChecked className="sr-only peer" />
                      <div className="w-11 h-6 bg-slate-200 dark:bg-slate-600 peer-focus:ring-2 peer-focus:ring-blue-500/20 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                    </label>
                  </div>
                  <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-700/50 rounded-xl">
                    <div className="flex items-center gap-3">
                      <Shield size={18} className="text-slate-500" />
                      <div>
                        <p className="text-sm font-medium text-slate-700 dark:text-slate-200">IP Whitelisting</p>
                        <p className="text-xs text-slate-400">Restrict access to specific IP addresses</p>
                      </div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" className="sr-only peer" />
                      <div className="w-11 h-6 bg-slate-200 dark:bg-slate-600 peer-focus:ring-2 peer-focus:ring-blue-500/20 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                    </label>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">
                      Session Timeout (minutes)
                    </label>
                    <input
                      type="number"
                      defaultValue={30}
                      className="w-full px-4 py-2.5 text-sm bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1.5">
                      Password Policy
                    </label>
                    <select className="w-full px-4 py-2.5 text-sm bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 text-slate-700 dark:text-slate-200">
                      <option>Standard (8+ characters)</option>
                      <option>Strong (12+ characters, mixed case, numbers)</option>
                      <option>Very Strong (16+ characters, special characters)</option>
                    </select>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'notifications' && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-base font-semibold text-slate-800 dark:text-white mb-1">Notification Settings</h3>
                  <p className="text-sm text-slate-500 dark:text-slate-400">Configure how and when notifications are sent</p>
                </div>

                <div className="space-y-4">
                  {[
                    { label: 'Deployment Notifications', desc: 'Notify when apps are deployed or updated' },
                    { label: 'Error Alerts', desc: 'Alert on application errors and downtime' },
                    { label: 'Billing Events', desc: 'Notify on payments and subscription changes' },
                    { label: 'Security Alerts', desc: 'Alert on suspicious activities and breaches' },
                    { label: 'Tenant Events', desc: 'Notify on tenant creation, updates, and deletions' },
                  ].map((item) => (
                    <div key={item.label} className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-700/50 rounded-xl">
                      <div>
                        <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{item.label}</p>
                        <p className="text-xs text-slate-400">{item.desc}</p>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" defaultChecked className="sr-only peer" />
                        <div className="w-11 h-6 bg-slate-200 dark:bg-slate-600 peer-focus:ring-2 peer-focus:ring-blue-500/20 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(activeTab === 'appearance' || activeTab === 'integrations' || activeTab === 'email') && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-base font-semibold text-slate-800 dark:text-white mb-1">
                    {tabs.find((t) => t.id === activeTab)?.label} Settings
                  </h3>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    Configure your {tabs.find((t) => t.id === activeTab)?.label.toLowerCase()} preferences
                  </p>
                </div>
                <div className="flex flex-col items-center justify-center py-12 text-slate-400">
                  <Settings size={40} className="mb-3 opacity-50" />
                  <p className="text-sm">Settings panel for this section</p>
                  <p className="text-xs mt-1">Configure options specific to this category</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

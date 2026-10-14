import { useState } from 'react';
import { X, Monitor, PanelLeft, PanelRight, PanelTop, Sun, Moon, Palette } from 'lucide-react';
import { useLayout, LayoutMode, AccentColor } from '../context/LayoutContext';

export default function LayoutSelector() {
  const [isOpen, setIsOpen] = useState(false);
  const { settings, setLayoutMode, setAccentColor, setColorScheme, isDark, toggleDarkMode } = useLayout();

  const layoutOptions: { id: LayoutMode; label: string; icon: React.ElementType; description: string }[] = [
    { id: 'sidebar-left', label: 'Left Sidebar', icon: PanelLeft, description: 'Navigation on the left side' },
    { id: 'sidebar-right', label: 'Right Sidebar', icon: PanelRight, description: 'Navigation on the right side' },
    { id: 'top-nav', label: 'Top Navigation', icon: PanelTop, description: 'Horizontal navigation bar' },
  ];

  const accentColors: { id: AccentColor; color: string; label: string }[] = [
    { id: 'blue', color: 'bg-blue-500', label: 'Blue' },
    { id: 'green', color: 'bg-green-500', label: 'Green' },
    { id: 'purple', color: 'bg-purple-500', label: 'Purple' },
    { id: 'amber', color: 'bg-amber-500', label: 'Amber' },
    { id: 'red', color: 'bg-red-500', label: 'Red' },
    { id: 'teal', color: 'bg-teal-500', label: 'Teal' },
  ];

  return (
    <>
      {/* Toggle Button */}
      <button
        onClick={() => setIsOpen(true)}
        className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400 transition-colors"
        title="Layout Settings"
      >
        <Monitor size={20} />
      </button>

      {/* Settings Panel */}
      {isOpen && (
        <div className="fixed inset-0 z-[100]">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 top-0 h-full w-full max-w-sm bg-white dark:bg-slate-800 shadow-2xl overflow-y-auto">
            {/* Header */}
            <div className="sticky top-0 bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 p-4 flex items-center justify-between z-10">
              <div>
                <h3 className="font-semibold text-slate-800 dark:text-white">Theme & Layout</h3>
                <p className="text-xs text-slate-400 mt-0.5">Customize your dashboard appearance</p>
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-4 space-y-6">
              {/* Layout Mode */}
              <div>
                <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
                  <PanelLeft size={14} />
                  Navigation Layout
                </h4>
                <div className="space-y-2">
                  {layoutOptions.map((option) => {
                    const Icon = option.icon;
                    const isActive = settings.layoutMode === option.id;
                    return (
                      <button
                        key={option.id}
                        onClick={() => setLayoutMode(option.id)}
                        className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all ${
                          isActive
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-500/10'
                            : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
                        }`}
                      >
                        <div className={`p-2 rounded-lg ${isActive ? 'bg-blue-100 dark:bg-blue-500/20' : 'bg-slate-100 dark:bg-slate-700'}`}>
                          <Icon size={18} className={isActive ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500'} />
                        </div>
                        <div className="text-left">
                          <p className={`text-sm font-medium ${isActive ? 'text-blue-700 dark:text-blue-400' : 'text-slate-700 dark:text-slate-200'}`}>
                            {option.label}
                          </p>
                          <p className="text-xs text-slate-400">{option.description}</p>
                        </div>
                        {isActive && (
                          <div className="ml-auto w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center">
                            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Color Scheme */}
              <div>
                <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
                  {isDark ? <Moon size={14} /> : <Sun size={14} />}
                  Color Scheme
                </h4>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => setColorScheme('light')}
                    className={`p-3 rounded-xl border-2 text-center transition-all ${
                      settings.colorScheme === 'light'
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-500/10'
                        : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'
                    }`}
                  >
                    <Sun size={18} className="mx-auto mb-1 text-amber-500" />
                    <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Light</span>
                  </button>
                  <button
                    onClick={() => setColorScheme('dark')}
                    className={`p-3 rounded-xl border-2 text-center transition-all ${
                      settings.colorScheme === 'dark'
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-500/10'
                        : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'
                    }`}
                  >
                    <Moon size={18} className="mx-auto mb-1 text-indigo-500" />
                    <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Dark</span>
                  </button>
                  <button
                    onClick={() => setColorScheme('auto')}
                    className={`p-3 rounded-xl border-2 text-center transition-all ${
                      settings.colorScheme === 'auto'
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-500/10'
                        : 'border-slate-200 dark:border-slate-700 hover:border-slate-300'
                    }`}
                  >
                    <Monitor size={18} className="mx-auto mb-1 text-slate-500" />
                    <span className="text-xs font-medium text-slate-600 dark:text-slate-300">Auto</span>
                  </button>
                </div>
              </div>

              {/* Accent Color */}
              <div>
                <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
                  <Palette size={14} />
                  Accent Color
                </h4>
                <div className="flex flex-wrap gap-3">
                  {accentColors.map((color) => (
                    <button
                      key={color.id}
                      onClick={() => setAccentColor(color.id)}
                      className={`w-9 h-9 rounded-full ${color.color} transition-all ${
                        settings.accentColor === color.id
                          ? 'ring-2 ring-offset-2 ring-offset-white dark:ring-offset-slate-800 ring-slate-400 scale-110'
                          : 'hover:scale-110'
                      }`}
                      title={color.label}
                    />
                  ))}
                </div>
              </div>

              {/* Quick Toggle */}
              <div>
                <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">
                  Quick Toggle
                </h4>
                <button
                  onClick={toggleDarkMode}
                  className="w-full flex items-center justify-between p-3 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    {isDark ? <Moon size={18} className="text-indigo-500" /> : <Sun size={18} className="text-amber-500" />}
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
                      {isDark ? 'Dark Mode' : 'Light Mode'}
                    </span>
                  </div>
                  <div className={`w-11 h-6 rounded-full relative transition-colors ${isDark ? 'bg-blue-600' : 'bg-slate-300'}`}>
                    <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${isDark ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

export type LayoutMode = 'sidebar-left' | 'sidebar-right' | 'top-nav';
export type ColorScheme = 'light' | 'dark' | 'auto';
export type AccentColor = 'blue' | 'green' | 'purple' | 'amber' | 'red' | 'teal';

interface LayoutSettings {
  layoutMode: LayoutMode;
  colorScheme: ColorScheme;
  accentColor: AccentColor;
  sidebarCollapsed: boolean;
}

interface LayoutContextType {
  settings: LayoutSettings;
  setLayoutMode: (mode: LayoutMode) => void;
  setColorScheme: (scheme: ColorScheme) => void;
  setAccentColor: (color: AccentColor) => void;
  toggleSidebar: () => void;
  toggleDarkMode: () => void;
  isDark: boolean;
}

const defaultSettings: LayoutSettings = {
  layoutMode: 'sidebar-left',
  colorScheme: 'light',
  accentColor: 'blue',
  sidebarCollapsed: false,
};

const LayoutContext = createContext<LayoutContextType | undefined>(undefined);

export function LayoutProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<LayoutSettings>(() => {
    const saved = localStorage.getItem('layout-settings');
    if (saved) {
      try {
        return { ...defaultSettings, ...JSON.parse(saved) };
      } catch {
        return defaultSettings;
      }
    }
    return defaultSettings;
  });

  const [isDark, setIsDark] = useState(() => {
    if (settings.colorScheme === 'dark') return true;
    if (settings.colorScheme === 'auto') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return false;
  });

  useEffect(() => {
    localStorage.setItem('layout-settings', JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [isDark]);

  const setLayoutMode = (mode: LayoutMode) => {
    setSettings((prev) => ({ ...prev, layoutMode: mode }));
  };

  const setColorScheme = (scheme: ColorScheme) => {
    setSettings((prev) => ({ ...prev, colorScheme: scheme }));
    if (scheme === 'dark') {
      setIsDark(true);
    } else if (scheme === 'light') {
      setIsDark(false);
    } else {
      setIsDark(window.matchMedia('(prefers-color-scheme: dark)').matches);
    }
  };

  const setAccentColor = (color: AccentColor) => {
    setSettings((prev) => ({ ...prev, accentColor: color }));
  };

  const toggleSidebar = () => {
    setSettings((prev) => ({ ...prev, sidebarCollapsed: !prev.sidebarCollapsed }));
  };

  const toggleDarkMode = () => {
    const newDark = !isDark;
    setIsDark(newDark);
    setSettings((prev) => ({
      ...prev,
      colorScheme: newDark ? 'dark' : 'light',
    }));
  };

  return (
    <LayoutContext.Provider
      value={{
        settings,
        setLayoutMode,
        setColorScheme,
        setAccentColor,
        toggleSidebar,
        toggleDarkMode,
        isDark,
      }}
    >
      {children}
    </LayoutContext.Provider>
  );
}

export function useLayout() {
  const context = useContext(LayoutContext);
  if (!context) {
    throw new Error('useLayout must be used within a LayoutProvider');
  }
  return context;
}

/**
 * Light, dark, or following the device. The choice is kept in this browser
 * (public/theme.js applies it before the app loads, so there's no flash).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';

interface ThemeContextType {
  choice: ThemeChoice;
  /** What is showing now */
  dark: boolean;
  setChoice: (choice: ThemeChoice) => void;
  /** Light ↔ dark (from "system", the opposite of what shows) */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);
const KEY = 'theme';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');

function readChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(readChoice);
  const [systemDark, setSystemDark] = useState(() => media().matches);

  useEffect(() => {
    const m = media();
    const onChange = () => setSystemDark(m.matches);
    m.addEventListener('change', onChange);
    return () => m.removeEventListener('change', onChange);
  }, []);

  const dark = choice === 'dark' || (choice === 'system' && systemDark);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }, [dark]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    try {
      if (next === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* storage blocked: the choice lasts for this visit */
    }
  }, []);
  const toggle = useCallback(() => setChoice(dark ? 'light' : 'dark'), [dark, setChoice]);

  const value = useMemo(() => ({ choice, dark, setChoice, toggle }), [choice, dark, setChoice, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within a ThemeProvider');
  return context;
}

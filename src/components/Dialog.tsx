import type { ReactNode } from 'react';
import { X } from 'lucide-react';

/** Centered modal form. Clicking the backdrop or the X closes it. */
export function Dialog({ title, onClose, onSubmit, children, wide = false }: {
  title: string;
  onClose: () => void;
  onSubmit?: (e: React.FormEvent) => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <form role="dialog" aria-label={title} onSubmit={onSubmit ?? ((e) => e.preventDefault())} onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
        className={`w-full ${wide ? 'max-w-lg' : 'max-w-md'} max-h-[90vh] overflow-y-auto bg-white dark:bg-slate-800 rounded-xl p-6 space-y-4 shadow-xl`}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-800 dark:text-white">{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700"><X size={18} /></button>
        </div>
        {children}
      </form>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="text-slate-600 dark:text-slate-300">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="block mt-1 text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

'use client';

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export default function Modal({ open, onClose, title, children, footer, className = '' }) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKeyDown);
    panelRef.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`flex w-full max-w-lg mx-4 max-h-[90vh] flex-col outline-none rounded-xl border border-border-em bg-surface shadow-2xl overflow-hidden ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface2 shrink-0">
            <h2 className="text-[16px] font-semibold text-text-primary">{title}</h2>
            <button
              onClick={onClose}
              aria-label="Close"
              className="text-text-tertiary hover:text-text-primary transition-colors duration-150 cursor-pointer"
            >
              <X className="size-4" />
            </button>
          </div>
        )}
        <div className="p-4 overflow-y-auto">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border bg-surface2 shrink-0">{footer}</div>}
      </div>
    </div>
  );
}

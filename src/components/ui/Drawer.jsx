import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { Button } from './button';

// A side sheet for detail views. Covers the full viewport height above the
// app header (the old one started at a hard-coded 44px and left a gap under
// the 52px header).
export default function Drawer({ isOpen, onClose, title, description, footer, children }) {
  const overlayRef = useRef(null);
  const panelRef = useRef(null);

  // Move focus into the panel when it opens and hand it back to whatever
  // opened it when it closes. Keyed on `isOpen` alone, like Modal's, so a
  // caller's fresh `onClose` closure can't steal focus on every render.
  useEffect(() => {
    if (!isOpen) return undefined;
    const opener = document.activeElement;
    panelRef.current?.focus();
    return () => { if (opener && typeof opener.focus === 'function') opener.focus(); };
  }, [isOpen]);

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    if (isOpen) {
      document.body.style.overflow = 'hidden';
      window.addEventListener('keydown', handleEscape);
    } else {
      document.body.style.overflow = '';
    }

    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, onClose]);

  const handleOverlayClick = (e) => {
    if (e.target === overlayRef.current) {
      onClose();
    }
  };

  return (
    <>
      <div
        ref={overlayRef}
        onClick={handleOverlayClick}
        aria-hidden="true"
        className={`fixed inset-0 z-40 bg-[var(--scrim)] transition-opacity duration-200 ${
          isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      />

      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        aria-hidden={!isOpen}
        inert={!isOpen}
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-[480px] flex-col outline-none border-l border-border bg-surface sm:rounded-l-xl transition-[translate,visibility] duration-200 ease-out ${
          isOpen ? 'translate-x-0 shadow-modal' : 'invisible translate-x-full'
        }`}
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-fg">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-fg-muted">{description}</p>}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close" className="-mr-1.5">
            <X strokeWidth={1.5} />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5 text-sm">
          {children}
        </div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
      </div>
    </>
  );
}

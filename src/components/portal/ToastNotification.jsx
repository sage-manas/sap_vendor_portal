import React, { useEffect } from 'react';
import { X, CheckCircle2, AlertTriangle, AlertCircle, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';

const KIND = {
  success: { Icon: CheckCircle2, color: 'text-success', label: 'Success' },
  info: { Icon: Info, color: 'text-info', label: 'Info' },
  warning: { Icon: AlertTriangle, color: 'text-warning', label: 'Warning' },
  error: { Icon: AlertCircle, color: 'text-danger', label: 'Error' },
};

export default function ToastNotification({ toasts, removeToast }) {
  if (!toasts || toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 left-4 sm:left-auto z-50 flex flex-col gap-2 sm:w-[360px] pointer-events-none">
      {toasts.slice(0, 3).map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onClose={() => removeToast(toast.id)}
        />
      ))}
    </div>
  );
}

function ToastItem({ toast, onClose }) {
  const { type, message, duration = 5000 } = toast;

  useEffect(() => {
    const timer = setTimeout(() => {
      onClose();
    }, duration);
    return () => clearTimeout(timer);
  }, [duration, onClose]);

  const { Icon, color, label } = KIND[type] || KIND.info;

  return (
    <div
      role="alert"
      className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-surface py-3 pl-3.5 pr-2 text-sm text-fg shadow-popover animate-slide-down"
    >
      <Icon className={`mt-0.5 size-4 shrink-0 ${color}`} strokeWidth={1.5} aria-hidden="true" />
      <p className="flex-1 min-w-0">
        <span className="sr-only">{label}: </span>
        {message}
      </p>
      <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Dismiss" className="-my-1">
        <X strokeWidth={1.5} />
      </Button>
    </div>
  );
}

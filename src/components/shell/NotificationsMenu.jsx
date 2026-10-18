'use client';

import { Popover } from '@base-ui/react/popover';
import { AlertCircle, AlertTriangle, Bell, CheckCircle2, Info } from 'lucide-react';
import { usePortal } from '@/lib/portal-context';

const KIND = {
  success: { Icon: CheckCircle2, color: 'text-success' },
  warning: { Icon: AlertTriangle, color: 'text-warning' },
  error: { Icon: AlertCircle, color: 'text-danger' },
  info: { Icon: Info, color: 'text-fg-subtle' },
};

// Same behaviour as the old header bell: opening the list marks everything
// read, and "Clear all" empties it.
export default function NotificationsMenu() {
  const { notifications, markNotificationsRead, clearNotifications } = usePortal();
  const unread = notifications.filter((n) => !n.read).length;

  return (
    <Popover.Root onOpenChange={(open) => { if (open) markNotificationsRead(); }}>
      <Popover.Trigger
        className="relative grid size-8 place-items-center rounded-md text-fg-muted hover:bg-subtle hover:text-fg cursor-pointer data-[popup-open]:bg-subtle"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
      >
        <Bell className="size-4" strokeWidth={1.5} aria-hidden="true" />
        {unread > 0 && (
          <span aria-hidden="true" className="absolute right-1 top-1 min-w-4 rounded-full bg-fg px-1 text-center font-mono text-xs leading-4 text-canvas">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={6} className="z-50">
          <Popover.Popup className="w-80 overflow-hidden rounded-lg border border-border bg-surface text-sm shadow-popover outline-none data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 transition-opacity duration-150">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <Popover.Title className="font-medium text-fg">Notifications</Popover.Title>
              {notifications.length > 0 && (
                <button type="button" onClick={clearNotifications} className="text-xs text-fg-muted hover:text-fg cursor-pointer">
                  Clear all
                </button>
              )}
            </div>
            {notifications.length === 0 ? (
              <p className="px-3 py-4 text-fg-muted">No notifications yet.</p>
            ) : (
              <ul className="max-h-96 divide-y divide-border overflow-y-auto">
                {notifications.map((n) => {
                  const { Icon, color } = KIND[n.type] || KIND.info;
                  return (
                    <li key={n.id} className="flex items-start gap-2.5 px-3 py-2.5">
                      <Icon className={`mt-0.5 size-4 shrink-0 ${color}`} strokeWidth={1.5} aria-hidden="true" />
                      <div className="min-w-0">
                        <p className="text-fg">{n.message}</p>
                        <time className="text-xs text-fg-subtle" dateTime={new Date(n.timestamp).toISOString()}>
                          {new Date(n.timestamp).toLocaleTimeString('en-IN', { timeStyle: 'short' })}
                        </time>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

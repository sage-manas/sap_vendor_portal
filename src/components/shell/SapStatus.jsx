'use client';

import { useEffect, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { apiClient } from '@/lib/api-client';

// The one SAP connection indicator, in the top bar of the supplier portal and
// the tenant workspace. It reads GET /api/dashboard/sap-status — the
// workspace's own row of the platform health board — so it says what SAP is
// actually doing, not a fixed "Connected".

const REFRESH_MS = 60_000;

const STATES = {
  healthy: { dot: 'bg-success', label: 'SAP connected', sentence: 'Calls to SAP are succeeding.' },
  degraded: { dot: 'bg-warning', label: 'SAP degraded', sentence: 'Some recent calls to SAP failed. Data may be a little behind.' },
  failing: { dot: 'bg-danger', label: 'SAP unreachable', sentence: 'Calls to SAP are failing. What you see may be out of date until it recovers.' },
  simulated: { dot: 'bg-info', label: 'SAP simulator', sentence: 'This workspace is not connected to a real SAP system yet. Documents come from the built-in simulator.' },
  idle: { dot: 'bg-fg-subtle', label: 'SAP idle', sentence: 'Nothing has been exchanged with SAP in the last day.' },
  unknown: { dot: 'bg-fg-subtle', label: 'No SAP activity yet', sentence: 'This workspace has not exchanged anything with SAP yet.' },
  unavailable: { dot: 'bg-fg-subtle', label: 'SAP status unavailable', sentence: 'The status could not be loaded just now.' },
};

const relative = (iso) => {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
};

const absolute = (iso) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

export function useSapStatus() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      // A tab nobody is looking at doesn't need fresh status.
      if (document.hidden) return;
      try {
        // `background`: an expired session must not sign anyone out from a
        // poll they never asked for — their next real request will.
        const data = await apiClient.request('/dashboard/sap-status', { background: true });
        if (!cancelled) setStatus(data || { status: 'unavailable' });
      } catch {
        if (!cancelled) setStatus({ status: 'unavailable' });
      }
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    // Catch up as soon as the tab is visible again.
    const onVisible = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return status;
}

export default function SapStatus() {
  const data = useSapStatus();
  if (!data) return null;
  // `unknown` means no traffic in the window. If SAP has answered before, it is
  // idle rather than never connected.
  const key = data.status === 'unknown' && data.lastSyncAt ? 'idle' : data.status;
  const state = STATES[key] || STATES.unavailable;

  return (
    <Popover.Root>
      <Popover.Trigger
        className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-fg-muted hover:bg-subtle hover:text-fg cursor-pointer data-[popup-open]:bg-subtle"
        aria-label={`${state.label}. Show SAP connection details`}
      >
        <span className={`size-2 shrink-0 rounded-full ${state.dot}`} aria-hidden="true" />
        <span className="hidden lg:inline">{state.label}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={6} className="z-50">
          <Popover.Popup className="w-72 rounded-lg border border-border bg-surface p-4 text-sm text-fg shadow-popover outline-none data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 transition-opacity duration-150">
            <Popover.Title className="flex items-center gap-2 font-medium">
              <span className={`size-2 shrink-0 rounded-full ${state.dot}`} aria-hidden="true" />
              {state.label}
            </Popover.Title>
            <Popover.Description className="mt-1 text-fg-muted">{state.sentence}</Popover.Description>
            {!['unavailable', 'simulated'].includes(data.status) && (
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-border pt-3">
                {/* For a supplier these two rows cover their own documents only. */}
                <dt className="text-fg-muted">{data.scope === 'supplier' ? 'Your last sync' : 'Last synced'}</dt>
                <dd title={data.lastSyncAt ? absolute(data.lastSyncAt) : undefined}>
                  {data.lastSyncAt ? relative(data.lastSyncAt) : 'Never'}
                </dd>
                <dt className="text-fg-muted">System</dt>
                <dd className="capitalize">{data.environment}</dd>
                <dt className="text-fg-muted">{data.scope === 'supplier' ? `Your calls, ${data.windowHours} h` : `Last ${data.windowHours} h`}</dt>
                <dd>
                  <span className="num">{data.calls}</span> calls
                  {data.failures > 0 && <>, <span className="num text-danger">{data.failures}</span> failed</>}
                </dd>
              </dl>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ShoppingBag, LayoutDashboard } from 'lucide-react';
import AppShell from './AppShell';
import SapStatus from './SapStatus';
import UserMenu from './UserMenu';
import { apiClient } from '@/lib/api-client';

// The application shell shared by the supplier portal, the tenant workspace
// and the platform console (redesign phase 4).

const NAV = [
  { key: 'dashboard', label: 'Overview', icon: LayoutDashboard, active: true, onClick: () => {} },
  { key: 'pos', label: 'Orders', icon: ShoppingBag, active: false, onClick: () => {}, count: 3, countLabel: '3 orders need acknowledgement' },
];

const renderShell = () => render(
  <AppShell surface="supplier" identity={{ mark: 'N', title: 'Nucleus Manufacturing', caption: 'Supplier portal' }} nav={NAV}>
    <input aria-label="Search orders" />
    <p>page content</p>
  </AppShell>,
);

describe('AppShell', () => {
  beforeEach(() => localStorage.clear());

  it('labels every navigation item and marks the current one', () => {
    renderShell();
    const nav = screen.getByRole('navigation', { name: 'Supplier portal navigation' });
    expect(nav).toHaveTextContent('Overview');
    expect(screen.getByRole('button', { name: /^Overview/ })).toHaveAttribute('aria-current', 'page');
  });

  it('announces a count badge with what it counts, not just a number', () => {
    renderShell();
    expect(screen.getByRole('button', { name: /^Orders.*3 orders need acknowledgement$/ })).toBeInTheDocument();
  });

  it('collapses the sidebar and remembers it', () => {
    const { unmount } = renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(localStorage.getItem('vc-sidebar-collapsed')).toBe('1');
    unmount();

    renderShell();
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('toggles with Ctrl+B, but not while the person is typing', () => {
    renderShell();
    fireEvent.keyDown(screen.getByLabelText('Search orders'), { key: 'b', ctrlKey: true });
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
  });

  it('opens navigation as a dialog on a phone and closes it with Escape', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument();
  });
});

describe('SapStatus', () => {
  const states = [
    ['healthy', 'SAP connected'],
    ['degraded', 'SAP degraded'],
    ['failing', 'SAP unreachable'],
    ['unknown', 'No SAP activity yet'],
  ];

  it.each(states)('says "%s" in words', async (status, label) => {
    vi.spyOn(apiClient, 'request').mockResolvedValue({
      status, environment: 'sandbox', lastSyncAt: null, windowHours: 24, calls: 0, failures: 0,
    });
    render(<SapStatus />);
    expect(await screen.findByRole('button', { name: `${label}. Show SAP connection details` })).toBeInTheDocument();
  });

  it('calls a workspace with past traffic but none today idle, not never-connected', async () => {
    vi.spyOn(apiClient, 'request').mockResolvedValue({
      status: 'unknown', environment: 'sandbox', lastSyncAt: '2026-09-07T04:00:00.000Z', windowHours: 24, calls: 0, failures: 0,
    });
    render(<SapStatus />);
    expect(await screen.findByRole('button', { name: /^SAP idle\./ })).toBeInTheDocument();
  });

  it('says the status is unavailable rather than guessing when the request fails', async () => {
    vi.spyOn(apiClient, 'request').mockRejectedValue(new Error('offline'));
    render(<SapStatus />);
    expect(await screen.findByRole('button', { name: /SAP status unavailable/ })).toBeInTheDocument();
  });

  it('says a workspace on the built-in simulator is a simulator, never "connected"', async () => {
    vi.spyOn(apiClient, 'request').mockResolvedValue({ status: 'simulated', environment: 'sandbox', windowHours: 24, calls: 5, failures: 0 });
    render(<SapStatus />);
    expect(await screen.findByRole('button', { name: /^SAP simulator\./ })).toBeInTheDocument();
    expect(screen.queryByText('SAP connected')).not.toBeInTheDocument();
  });

  it('polls as a background request, so an expired session can\'t sign anyone out mid-form', async () => {
    const spy = vi.spyOn(apiClient, 'request').mockResolvedValue({ status: 'healthy', environment: 'sandbox', windowHours: 24, calls: 1, failures: 0 });
    render(<SapStatus />);
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/dashboard/sap-status', { background: true }));
  });

  it('does not poll from a hidden tab', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const spy = vi.spyOn(apiClient, 'request').mockResolvedValue({ status: 'healthy' });
    render(<SapStatus />);
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled();
    hidden.mockRestore();
  });
});

describe('UserMenu', () => {
  it('never shows a separator at the edge or two in a row', async () => {
    render(<UserMenu name="Meridian Castings" items={['separator', { label: 'Sign out', onClick: () => {} }, 'separator']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Account: Meridian Castings' }));
    await screen.findByRole('menuitem', { name: 'Sign out' });
    // Only the one under the name/caption header.
    expect(screen.getAllByRole('separator')).toHaveLength(1);
  });
});

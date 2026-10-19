import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import DesignPage from '@/app/%5F%5Fdesign/page';
import StatusBadge from '@/components/ui/StatusBadge';
import KPICard from '@/components/ui/KPICard';
import Drawer from '@/components/ui/Drawer';
import DataTable from '@/components/ui/DataTable';

// /__design is the design system's test bed (docs/redesign/design-system.md):
// visible in development, absent from production.

vi.mock('next/navigation', async (orig) => ({
  ...(await orig()),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));

describe('/__design', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('renders every primitive, light and dark, in development', () => {
    render(<DesignPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Design system' })).toBeInTheDocument();
    // One bed per theme.
    expect(screen.getAllByRole('table', { name: 'Purchase orders' })).toHaveLength(2);
    // The whole test bed, twice: under a loaded full-suite run it can pass 5s.
  }, 15000);

  it('is not served in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => render(<DesignPage />)).toThrow('NEXT_NOT_FOUND');
  });
});

describe('StatusBadge', () => {
  it('gives a status the same tone whatever variant a caller passes', () => {
    const { container } = render(<>
      <StatusBadge label="Cleared" variant="warn" />
      <StatusBadge label="Cleared" variant="active" />
    </>);
    const [a, b] = container.querySelectorAll('.status-badge');
    expect(a.className).toBe(b.className);
    expect(a).toHaveClass('status-badge-active');
  });

  it('falls back to the caller\'s variant for a label the map does not know', () => {
    render(<StatusBadge label="Something new" variant="suspended" />);
    expect(screen.getByText('Something new')).toHaveClass('status-badge-suspended');
  });

  it('keeps the label exactly as given', () => {
    render(<StatusBadge label="Bidding Open" />);
    expect(screen.getByText('Bidding Open')).toBeInTheDocument();
  });
});

describe('Drawer', () => {
  it('moves focus into the panel when it opens and back to the opener when it closes', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open order</button>
          <Drawer isOpen={open} onClose={() => setOpen(false)} title="PO-2026-0077">body</Drawer>
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open order' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('dialog', { name: 'PO-2026-0077' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(opener).toHaveFocus();
  });
});

describe('DataTable on a phone', () => {
  it('gives a clickable row a labelled button, not just a clickable card', () => {
    vi.stubGlobal('matchMedia', (query) => ({ matches: query === '(max-width: 767px)', addEventListener() {}, removeEventListener() {} }));
    const onRowClick = vi.fn();
    render(<DataTable caption="Orders" columns={[{ key: 'id', header: 'Order' }]} rows={[{ id: 'PO-1' }]} onRowClick={onRowClick} rowLabel={(r) => r.id} />);

    expect(screen.queryByRole('table')).not.toBeInTheDocument(); // one layout, not both
    fireEvent.click(screen.getByRole('button', { name: 'Open PO-1' }));
    expect(onRowClick).toHaveBeenCalledWith({ id: 'PO-1' });
    vi.unstubAllGlobals();
  });
});

describe('KPICard', () => {
  it('renders a zero muted rather than as a headline figure', () => {
    render(<KPICard label="Awaiting payment" value="₹0" hint="Nothing outstanding" />);
    expect(screen.getByText('₹0')).toHaveClass('text-fg-subtle');
  });

  it('renders a real figure as the headline', () => {
    render(<KPICard label="Open orders" value="12" />);
    expect(screen.getByText('12')).toHaveClass('text-2xl');
  });
});

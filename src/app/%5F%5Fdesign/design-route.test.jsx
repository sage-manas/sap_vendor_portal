import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import DesignPage from '@/app/%5F%5Fdesign/page';
import StatusBadge from '@/components/ui/StatusBadge';
import KPICard from '@/components/ui/KPICard';

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
  });

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

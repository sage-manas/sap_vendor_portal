import { notFound } from 'next/navigation';
import DesignBed from './DesignBed';

// /__design — the design system's visual test bed (docs/redesign/design-system.md).
// Development only: production builds answer 404.
export const metadata = { title: 'Design system' };

export default function DesignPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <DesignBed />;
}

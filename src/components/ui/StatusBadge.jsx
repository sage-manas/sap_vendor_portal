import { statusClass } from './status';

/**
 * A status: a dot and the status's own words.
 *
 * The tone comes from the shared domain map in ./status.js, keyed by the label,
 * so "Cleared" looks the same on every screen whatever variant a caller
 * passes. `variant` (the legacy prop) is only used for labels the map does
 * not know; `tone` overrides both when a screen genuinely means something
 * different.
 */
export default function StatusBadge({ label, variant = 'info', tone, className = '' }) {
  return (
    <span className={`status-badge ${statusClass(label, variant, tone)} ${className}`}>
      {label}
    </span>
  );
}

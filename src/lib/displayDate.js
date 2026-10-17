// 10 May 2026 — the app's one display format for a date. Documents arrive
// with ISO timestamps; nobody reads those. A value that does not parse is
// shown as it came, never as "Invalid Date".
export const displayDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

export default function Spinner({ size = 16, className = '', label = 'Loading' }) {
  return (
    <span
      className={`inline-block shrink-0 rounded-full border-[1.5px] border-current border-r-transparent text-fg-subtle animate-spin ${className}`}
      style={{ width: size, height: size, animationDuration: '0.7s' }}
      role="status"
      aria-label={label}
    />
  );
}

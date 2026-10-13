/** Marks someone who is sharing their screen, wherever they are listed. */
export function LivePill({ className = "" }: { className?: string }) {
  return (
    <span
      className={`shrink-0 rounded-full bg-red-600 px-1.5 py-px text-3xs font-bold leading-none tracking-wide text-white ${className}`}
    >
      LIVE
    </span>
  );
}

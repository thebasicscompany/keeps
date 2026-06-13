const MAX_QUOTE_LENGTH = 140;

// Inline SVG lock icon — no emoji, no external dependency
function LockIcon() {
  return (
    <svg
      aria-hidden="true"
      className="inline-block size-3 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      viewBox="0 0 24 24"
    >
      <rect x="3" y="11" width="18" height="11" rx="0" ry="0" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

interface SourceEvidenceChipProps {
  quote: string;
  canViewSensitiveEvidence: boolean;
  token: string;
}

export function SourceEvidenceChip({
  quote,
  canViewSensitiveEvidence,
  token,
}: SourceEvidenceChipProps) {
  if (!canViewSensitiveEvidence) {
    return (
      <a
        href={`/sign-in?next=/r/${token}`}
        className="inline-flex items-center gap-1 rounded-none border border-[#E2E2DD] bg-[#F4F4F0] px-2 py-0.5 text-xs font-medium text-[#6F6F66] transition-colors hover:border-[#14140F] hover:text-[#14140F]"
      >
        <LockIcon />
        Sign in to view source
      </a>
    );
  }

  const displayText =
    quote.length > MAX_QUOTE_LENGTH ? quote.slice(0, MAX_QUOTE_LENGTH) + "…" : quote;

  return (
    <span
      className="inline-block max-w-full truncate rounded-none border border-[#E2E2DD] bg-[#F4F4F0] px-2 py-0.5 text-xs font-medium text-[#6F6F66]"
      title={quote}
    >
      &ldquo;{displayText}&rdquo;
    </span>
  );
}

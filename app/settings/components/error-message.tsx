/**
 * app/settings/components/error-message.tsx
 *
 * Styled error display: low-contrast card with error-red text.
 * Replaces bare red text (e.g. "text-[#B42318]") used inline in
 * connect-button.tsx and any other settings UI.
 *
 * Intentionally not "use client" — can be rendered in both server
 * and client components.
 */

export interface ErrorMessageProps {
  /** The error string to display. Renders nothing when falsy. */
  message: string | null | undefined;
}

export function ErrorMessage({ message }: ErrorMessageProps) {
  if (!message) return null;

  return (
    <p
      role="alert"
      className="rounded-none bg-[#FEF3F2] px-3 py-2 text-xs font-medium text-[#B42318]"
    >
      {message}
    </p>
  );
}

"use client";

/**
 * app/settings/connectors/connect-button.tsx
 *
 * Client component for connector actions.
 *
 * ConnectButton handles three interaction modes:
 *   1. "Connect" / "Reconnect" — calls the injected connectAction (server
 *      action returning ConnectFlowResult), then navigates to the redirect URL
 *      via window.location.href. On error: shows inline message.
 *   2. "Disconnect" — calls the injected disconnectAction (server action), then
 *      calls router.refresh() to reload the server-rendered page.
 *
 * Inline error states:
 *   - error: 'not_configured' → "Connectors aren't configured yet."
 *   - all other errors       → "Something went wrong. Please try again."
 *   - disconnectAction failure → "Could not disconnect. Please try again."
 *
 * Design: square seafoam (radius 0, Bricolage Grotesque via body font).
 * Button sizes are smaller than the full-bleed primaryButtonClass from the
 * stepper (h-16) to fit inline within a settings card row.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ConnectFlowResult } from "@/connectors/connect-flow";
import type { DisconnectFlowResult } from "./actions";
import { compactPrimaryButtonClass, secondaryButtonClass } from "../_ui";
import { ErrorMessage } from "../components/error-message";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type ConnectButtonMode =
  | {
      /** "Connect" or "Reconnect" — navigates to Composio OAuth. */
      connectAction: () => Promise<ConnectFlowResult | unknown>;
      disconnectAction?: never;
    }
  | {
      /** "Disconnect" — flips status to disabled and refreshes the page. */
      connectAction?: never;
      disconnectAction: () => Promise<DisconnectFlowResult | unknown>;
    };

export type ConnectButtonProps = ConnectButtonMode & {
  label: string;
  variant: "primary" | "secondary";
};

// ---------------------------------------------------------------------------
// ConnectButton
// ---------------------------------------------------------------------------

export function ConnectButton({
  label,
  variant,
  connectAction,
  disconnectAction,
}: ConnectButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const btnClass =
    variant === "primary" ? compactPrimaryButtonClass : secondaryButtonClass;

  async function handleConnect() {
    if (!connectAction) return;
    setError(null);

    try {
      const result = (await connectAction()) as ConnectFlowResult;

      if (result.ok) {
        // Navigate the browser to the Composio OAuth page.
        window.location.href = result.redirectUrl;
        return;
      }

      // Typed error outcomes
      if (result.error === "not_configured") {
        setError("Connectors aren't configured yet.");
      } else {
        setError("Something went wrong. Please try again.");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    }
  }

  function handleDisconnect() {
    if (!disconnectAction) return;
    setError(null);

    startTransition(async () => {
      try {
        const result = (await disconnectAction()) as DisconnectFlowResult;

        if (result.ok) {
          router.refresh();
          return;
        }

        // Typed error outcomes for disconnect
        if (result.error === "not_configured") {
          setError("Connectors aren't configured yet.");
        } else {
          setError("Could not disconnect. Please try again.");
        }
      } catch {
        setError("Could not disconnect. Please try again.");
      }
    });
  }

  const isConnect = !!connectAction;
  const busy = isPending;

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className={btnClass}
        disabled={busy}
        onClick={isConnect ? () => void handleConnect() : handleDisconnect}
      >
        {busy ? `${label}…` : label}
      </button>

      <ErrorMessage message={error} />
    </div>
  );
}

/**
 * app/settings/connectors/page.tsx
 *
 * Clerk-protected server component that renders the Connectors settings page.
 *
 * Auth pattern: identical to app/settings/page.tsx — auth() from @clerk/nextjs/server
 * yields the Clerk user ID, which we join against user_identities to get the
 * INTERNAL Keeps user UUID (users.id). That UUID is used to query connector_accounts.
 *
 * Design language: square seafoam — matches app/settings/page.tsx and
 * app/get-started-stepper.tsx. Tokens duplicated here to keep the settings
 * section self-contained (no cross-app import of tokens that live in a
 * "use client" component).
 */

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Route } from "next";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/db/client";
import { userIdentities, connectorAccounts } from "@/db/schema";
import type { ConnectorAccount } from "@/db/schema";
import { startConnectorConnect, startConnectorReconnect, startConnectorDisconnect } from "./actions";
import { ConnectButton } from "./connect-button";

// ---------------------------------------------------------------------------
// Design tokens — copied from app/settings/page.tsx / get-started-stepper.tsx
// ---------------------------------------------------------------------------

const creamBg = "bg-[#FAFAF8]";
const cardBg =
  "bg-white border border-[#E2E2DD] shadow-[0_24px_70px_rgba(20,20,15,0.07)]";
const labelMuted = "text-[#6F6F66]";
const sectionDivider = "border-t border-[#E2E2DD]";

// ---------------------------------------------------------------------------
// View-model — pure function, no I/O; exported for unit tests (D3 / D4)
// ---------------------------------------------------------------------------

export type ConnectorAction =
  | { kind: "connect" }
  | { kind: "reconnect" }
  | { kind: "disconnect" };

export interface ConnectorCardViewModel {
  provider: "slack" | "google_calendar";
  label: string;
  description: string;
  statusText: string;
  statusVariant: "none" | "active" | "error";
  actions: ConnectorAction[];
}

/**
 * Derives the display model for a connector card from its DB row (or null).
 *
 * States:
 *   - null row OR status='disabled'  → "Not connected"     actions: [connect]
 *   - status='active'                → "Connected as <…>"  actions: [disconnect]
 *   - status='revoked'|'auth_error'  → "Needs reconnect"   actions: [reconnect, disconnect]
 *   - any other status               → "Error (<reason>)"  actions: [reconnect, disconnect]
 */
export function connectorCardViewModel(
  provider: "slack" | "google_calendar",
  account: ConnectorAccount | null,
): ConnectorCardViewModel {
  const meta =
    provider === "slack"
      ? { label: "Slack", description: "Send direct messages from Keeps." }
      : {
          label: "Google Calendar",
          description: "Create events and reminders from Keeps.",
        };

  if (!account || account.status === "disabled") {
    return {
      provider,
      label: meta.label,
      description: meta.description,
      statusText: "Not connected",
      statusVariant: "none",
      actions: [{ kind: "connect" }],
    };
  }

  if (account.status === "active") {
    const identity =
      account.externalAccountEmail ??
      account.externalAccountLabel ??
      null;
    return {
      provider,
      label: meta.label,
      description: meta.description,
      statusText: identity ? `Connected as ${identity}` : "Connected",
      statusVariant: "active",
      actions: [{ kind: "disconnect" }],
    };
  }

  if (account.status === "revoked" || account.status === "auth_error") {
    return {
      provider,
      label: meta.label,
      description: meta.description,
      statusText: "Needs reconnect",
      statusVariant: "error",
      actions: [{ kind: "reconnect" }, { kind: "disconnect" }],
    };
  }

  // Fallback: any other status (shouldn't be reached in V0 schema)
  const reason = account.statusReason ?? account.status;
  return {
    provider,
    label: meta.label,
    description: meta.description,
    statusText: `Error (${reason})`,
    statusVariant: "error",
    actions: [{ kind: "reconnect" }, { kind: "disconnect" }],
  };
}

// ---------------------------------------------------------------------------
// Data resolver
// ---------------------------------------------------------------------------

async function resolveConnectors(clerkUserId: string): Promise<{
  slack: ConnectorAccount | null;
  google_calendar: ConnectorAccount | null;
}> {
  const db = getDb();

  const rows = await db
    .select({
      id: connectorAccounts.id,
      userId: connectorAccounts.userId,
      provider: connectorAccounts.provider,
      composioConnectedAccountId: connectorAccounts.composioConnectedAccountId,
      composioEntityId: connectorAccounts.composioEntityId,
      externalAccountEmail: connectorAccounts.externalAccountEmail,
      externalAccountLabel: connectorAccounts.externalAccountLabel,
      scopes: connectorAccounts.scopes,
      status: connectorAccounts.status,
      statusReason: connectorAccounts.statusReason,
      metadata: connectorAccounts.metadata,
      connectedAt: connectorAccounts.connectedAt,
      lastUsedAt: connectorAccounts.lastUsedAt,
      disconnectedAt: connectorAccounts.disconnectedAt,
      createdAt: connectorAccounts.createdAt,
      updatedAt: connectorAccounts.updatedAt,
    })
    .from(connectorAccounts)
    .innerJoin(
      userIdentities,
      and(
        eq(userIdentities.userId, connectorAccounts.userId),
        eq(userIdentities.provider, "clerk"),
        eq(userIdentities.providerAccountId, clerkUserId),
      ),
    );

  const slack = rows.find((r) => r.provider === "slack") ?? null;
  const calendar = rows.find((r) => r.provider === "google_calendar") ?? null;

  return { slack, google_calendar: calendar };
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default async function ConnectorsPage() {
  const { userId: clerkUserId } = await auth();

  if (!clerkUserId) {
    redirect("/sign-in?redirect_url=/settings/connectors" as Route);
  }

  const accounts = await resolveConnectors(clerkUserId);

  const slackVm = connectorCardViewModel("slack", accounts.slack);
  const calendarVm = connectorCardViewModel("google_calendar", accounts.google_calendar);

  return (
    <main className={`relative z-10 min-h-svh ${creamBg} text-[#14140F]`}>
      <section className="mx-auto flex min-h-svh w-full max-w-[546px] flex-col justify-center px-5 py-9 sm:px-0">
        <div className={`rounded-none ${cardBg} p-5 sm:p-6`}>
          {/* Header */}
          <div className="mb-8">
            <div
              className="mb-5 flex size-14 items-center justify-center rounded-none bg-[#14140F] text-[#C1F5DF]"
              aria-hidden="true"
            >
              {/* Plug / connector icon */}
              <svg
                className="size-7"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.4}
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"
                />
              </svg>
            </div>
            <h1 className="text-[28px] leading-tight font-bold tracking-normal text-[#14140F]">
              Connectors
            </h1>
            <p className={`mt-1 text-[17px] leading-tight font-medium ${labelMuted}`}>
              Connect Keeps to Slack and Google Calendar.
            </p>
          </div>

          {/* Connector cards */}
          <div className="space-y-5">
            <ConnectorCard
              vm={slackVm}
              connectAction={startConnectorConnect.bind(null, "slack")}
              reconnectAction={startConnectorReconnect.bind(null, "slack")}
              disconnectAction={startConnectorDisconnect.bind(null, "slack")}
            />

            <div className={sectionDivider} />

            <ConnectorCard
              vm={calendarVm}
              connectAction={startConnectorConnect.bind(null, "google_calendar")}
              reconnectAction={startConnectorReconnect.bind(null, "google_calendar")}
              disconnectAction={startConnectorDisconnect.bind(null, "google_calendar")}
            />
          </div>

          {/* Footer link back to settings */}
          <div className={`mt-8 pt-5 ${sectionDivider}`}>
            <a
              href="/settings"
              className={`text-sm font-medium ${labelMuted} hover:text-[#14140F] transition-colors`}
            >
              Back to settings
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// ConnectorCard — renders a single provider row
// ---------------------------------------------------------------------------

function ConnectorCard({
  vm,
  connectAction,
  reconnectAction,
  disconnectAction,
}: {
  vm: ConnectorCardViewModel;
  connectAction: () => Promise<unknown>;
  reconnectAction: () => Promise<unknown>;
  disconnectAction: () => Promise<unknown>;
}) {
  return (
    <div className="flex flex-col gap-4 py-1">
      {/* Provider identity + status */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-base font-semibold text-[#14140F]">{vm.label}</p>
          <p className={`mt-0.5 text-sm ${labelMuted}`}>{vm.description}</p>
        </div>
        <StatusBadge variant={vm.statusVariant} text={vm.statusText} />
      </div>

      {/* Action buttons */}
      {vm.actions.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {vm.actions.map((action) => {
            if (action.kind === "connect") {
              return (
                <ConnectButton
                  key="connect"
                  label="Connect"
                  variant="primary"
                  connectAction={connectAction}
                />
              );
            }
            if (action.kind === "reconnect") {
              return (
                <ConnectButton
                  key="reconnect"
                  label="Reconnect"
                  variant="primary"
                  connectAction={reconnectAction}
                />
              );
            }
            if (action.kind === "disconnect") {
              return (
                <ConnectButton
                  key="disconnect"
                  label="Disconnect"
                  variant="secondary"
                  disconnectAction={disconnectAction}
                />
              );
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusBadge — inline pill showing connection state
// ---------------------------------------------------------------------------

function StatusBadge({
  variant,
  text,
}: {
  variant: "none" | "active" | "error";
  text: string;
}) {
  const styles: Record<typeof variant, string> = {
    none: "bg-[#F4F4F0] text-[#6F6F66]",
    active: "bg-[#E9FBF4] text-[#1E6B4F]",
    error: "bg-[#FEF3F2] text-[#B42318]",
  };

  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-none px-2.5 py-1 text-xs font-semibold ${styles[variant]}`}
    >
      {text}
    </span>
  );
}

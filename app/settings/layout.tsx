/**
 * app/settings/layout.tsx
 *
 * Shared shell for all settings pages (/settings and /settings/connectors).
 *
 * Provides:
 *   - paper (#FAFAF8) full-height background
 *   - centered max-w-[546px] container with vertical padding
 *   - top header: "Settings" title + tab nav (Settings | Connectors)
 *
 * Individual page components render their card content inside {children};
 * each page no longer needs its own outer <main> / background / container.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import type { Route } from "next";
import { UserButton } from "@clerk/nextjs";
import { SettingsNav } from "./components/settings-nav";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <main className="keeps-home relative min-h-svh">
      <div className="mx-auto flex min-h-svh w-full max-w-[546px] flex-col px-5 py-9 sm:px-0">
        {/* Top header -------------------------------------------------------- */}
        <header className="mb-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h1 className="text-[26px] font-light leading-tight tracking-[-0.01em] text-[#14140F]">
              Home
            </h1>
            <div className="flex items-center gap-3">
              <Link
                href={"/get-started" as Route}
                className="keeps-mono inline-flex h-9 items-center rounded-[4px] border border-[#DEDED8] px-3 text-[12px] uppercase text-[#6F6F66] transition-colors hover:border-[#14140F] hover:text-[#14140F]"
              >
                Get started
              </Link>
              <UserButton />
            </div>
          </div>
          <SettingsNav />
        </header>

        {/* Page content ------------------------------------------------------- */}
        {children}
      </div>
    </main>
  );
}

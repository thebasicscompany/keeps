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
import { SettingsNav } from "./components/settings-nav";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <main className="relative z-10 min-h-svh bg-[#FAFAF8] text-[#14140F]">
      <div className="mx-auto flex min-h-svh w-full max-w-[546px] flex-col px-5 py-9 sm:px-0">
        {/* Top header -------------------------------------------------------- */}
        <header className="mb-6">
          <h1 className="mb-3 text-[22px] font-bold leading-tight tracking-normal text-[#14140F]">
            Settings
          </h1>
          <SettingsNav />
        </header>

        {/* Page content ------------------------------------------------------- */}
        {children}
      </div>
    </main>
  );
}

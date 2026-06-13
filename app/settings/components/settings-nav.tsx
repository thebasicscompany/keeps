"use client";

/**
 * app/settings/components/settings-nav.tsx
 *
 * Client component: tab-style nav for the settings section.
 * Uses usePathname to mark the active tab.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { label: "Settings", href: "/settings" },
  { label: "Connectors", href: "/settings/connectors" },
] as const;

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1" aria-label="Settings navigation">
      {tabs.map(({ label, href }) => {
        // Exact match for /settings; prefix match for deeper pages.
        const isActive =
          href === "/settings" ? pathname === "/settings" : pathname.startsWith(href);

        return (
          <Link
            key={href}
            href={href}
            className={[
              "rounded-none px-4 py-2 text-sm font-semibold transition-colors",
              isActive
                ? "bg-[#C1F5DF] text-[#14140F]"
                : "text-[#6F6F66] hover:bg-[#E9FBF4] hover:text-[#14140F]",
            ].join(" ")}
            aria-current={isActive ? "page" : undefined}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

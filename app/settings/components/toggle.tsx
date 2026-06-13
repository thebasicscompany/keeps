"use client";

/**
 * app/settings/components/toggle.tsx
 *
 * Accessible toggle switch that replaces the native <input type="checkbox">.
 *
 * - Square track (rounded-none) per Keeps design system
 * - Seafoam (#C1F5DF) when on, neutral border when off
 * - Submits as a hidden <input name={name} value="on"> so the server action
 *   receives the same FormData shape as the previous <input type="checkbox">.
 * - Accessible: role="switch", aria-checked, keyboard activatable (Space/Enter).
 */

import { useState } from "react";

export interface ToggleProps {
  /** Form field name — FormData key. */
  name: string;
  /** HTML id for the associated <label htmlFor>. */
  id: string;
  /** Initial checked state. */
  defaultChecked?: boolean;
}

export function Toggle({ name, id, defaultChecked = false }: ToggleProps) {
  const [checked, setChecked] = useState(defaultChecked);

  function toggle() {
    setChecked((v) => !v);
  }

  return (
    <>
      {/* Hidden form input — present only when checked so FormData matches
          the old <input type="checkbox" value="on"> behaviour. */}
      {checked && <input type="hidden" name={name} value="on" />}

      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            toggle();
          }
        }}
        className={[
          // Track
          "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-none border-2 transition-colors duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(30,107,79,0.32)]",
          checked
            ? "border-[#1E6B4F] bg-[#C1F5DF]"
            : "border-[#E2E2DD] bg-[#F4F4F0]",
        ].join(" ")}
      >
        {/* Thumb */}
        <span
          aria-hidden="true"
          className={[
            "pointer-events-none inline-block h-4 w-4 rounded-none shadow-sm transition-transform duration-150",
            "mt-[1px]",
            checked
              ? "translate-x-5 bg-[#1E6B4F]"
              : "translate-x-0 bg-[#6F6F66]",
          ].join(" ")}
        />
      </button>
    </>
  );
}

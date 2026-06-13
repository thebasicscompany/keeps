"use client";

/**
 * app/settings/components/styled-select.tsx
 *
 * Styled <select> wrapper that matches inputClass from _ui.ts.
 * Uses appearance-none + a custom SVG chevron so the native control
 * is still used for a11y and native behaviour, but looks on-brand.
 *
 * Works as both a controlled (value + onChange) and an uncontrolled
 * (defaultValue) component.
 */

import { inputClass } from "../_ui";

export interface StyledSelectOption {
  value: string | number;
  label: string;
}

export interface StyledSelectProps {
  id?: string;
  name?: string;
  defaultValue?: string | number;
  value?: string | number;
  onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  options: StyledSelectOption[];
  className?: string;
}

export function StyledSelect({
  id,
  name,
  defaultValue,
  value,
  onChange,
  options,
  className,
}: StyledSelectProps) {
  return (
    <div className="relative w-full">
      <select
        id={id}
        name={name}
        defaultValue={defaultValue}
        value={value}
        onChange={onChange}
        className={[
          inputClass,
          // Remove native arrow and make room for our chevron
          "appearance-none pr-10",
          className ?? "",
        ].join(" ")}
      >
        {options.map(({ value: v, label }) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>

      {/* Custom chevron — pointer-events-none so clicks pass through to select */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[#6F6F66]"
      >
        <svg
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
        </svg>
      </span>
    </div>
  );
}

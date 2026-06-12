"use client";

import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { workingStyles } from "@/product/working-styles";

type WorkingStyle = (typeof workingStyles)[number];

export function WorkingStylePicker({ styles }: { styles: readonly WorkingStyle[] }) {
  const [selected, setSelected] = useState("direct");

  useEffect(() => {
    const stored = window.localStorage.getItem("keeps.workingStyle");
    if (stored) {
      setSelected(stored);
    }
  }, []);

  function choose(styleId: string) {
    setSelected(styleId);
    window.localStorage.setItem("keeps.workingStyle", styleId);
  }

  return (
    <div className="grid gap-2.5" role="radiogroup" aria-label="Working style">
      {styles.map((style) => (
        <button
          className={cn(
            "group flex min-h-[68px] rounded-none border border-[#E2E2DD] bg-white px-5 py-3.5 text-left transition-colors hover:bg-[#E9FBF4] focus-visible:ring-2 focus-visible:ring-[#14140F]/20 focus-visible:outline-none",
            selected === style.id &&
              "border-[rgba(30,107,79,0.32)] bg-[#E9FBF4] shadow-[inset_0_0_0_1px_rgba(30,107,79,0.28)]"
          )}
          data-selected={selected === style.id}
          key={style.id}
          onClick={() => choose(style.id)}
          role="radio"
          aria-checked={selected === style.id}
          type="button"
        >
          <span className="grid min-w-0 flex-1 gap-1">
            <span className="flex items-center justify-between gap-3">
              <strong className="text-sm font-semibold text-[#14140F]">{style.label}</strong>
              <Check
                className={cn(
                  "size-4 shrink-0 rounded-none bg-[#14140F] p-0.5 text-[#C1F5DF] opacity-0 transition-opacity",
                  selected === style.id && "opacity-100"
                )}
              />
            </span>
            <span className="text-sm leading-5 text-[#6F6F66]">{style.description}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

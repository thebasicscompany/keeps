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
            "group flex min-h-[68px] rounded-[24px] border border-[#e6dacd] bg-[#fffaf3]/82 px-5 py-3.5 text-left shadow-[inset_0_1px_0_rgb(255_255_255/0.68)] transition-colors hover:bg-[#fffaf3] focus-visible:ring-2 focus-visible:ring-[#171310]/20 focus-visible:outline-none",
            selected === style.id &&
              "border-[#bf5636]/26 bg-[#fffaf3] shadow-[inset_0_1px_0_rgb(255_255_255/0.72),0_8px_22px_rgb(125_55_28/0.1)]"
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
              <strong className="text-sm font-semibold text-[#171310]">{style.label}</strong>
              <Check
                className={cn(
                  "size-4 shrink-0 rounded-full bg-[#bf5636] p-0.5 text-white opacity-0 transition-opacity",
                  selected === style.id && "opacity-100"
                )}
              />
            </span>
            <span className="text-sm leading-5 text-[#7d7167]">{style.description}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

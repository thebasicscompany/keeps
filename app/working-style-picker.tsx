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
    <div className="keeps-style-picker" role="radiogroup" aria-label="Working style">
      {styles.map((style) => (
        <button
          className={cn(
            "keeps-style-option",
            selected === style.id && "is-selected"
          )}
          data-selected={selected === style.id}
          key={style.id}
          onClick={() => choose(style.id)}
          role="radio"
          aria-checked={selected === style.id}
          type="button"
        >
          <span className="keeps-style-option-copy">
            <span className="keeps-style-option-head">
              <strong>{style.label}</strong>
              <Check
                className={cn(
                  "keeps-style-check",
                  selected === style.id && "is-visible"
                )}
              />
            </span>
            <span className="keeps-style-description">{style.description}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

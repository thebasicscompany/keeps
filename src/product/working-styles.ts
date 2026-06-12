export const workingStyles = [
  {
    id: "brief",
    label: "Brief",
    description: "Short replies with only the next useful detail.",
  },
  {
    id: "warm",
    label: "Warm",
    description: "Concise and human without getting chatty.",
  },
  {
    id: "direct",
    label: "Direct",
    description: "Plain operational language and clear next steps.",
  },
  {
    id: "chief_of_staff",
    label: "Chief of Staff",
    description: "Structured, proactive, and focused on what might slip.",
  },
] as const;

export type WorkingStyleId = (typeof workingStyles)[number]["id"];

export function isWorkingStyleId(value: string): value is WorkingStyleId {
  return workingStyles.some((style) => style.id === value);
}

export function getWorkingStyle(id: string | null | undefined) {
  return workingStyles.find((style) => style.id === id) ?? workingStyles[2];
}

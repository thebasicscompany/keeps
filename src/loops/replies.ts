import type { LoopExtractionResult } from "@/agent/schemas";

export type PrivateReplyLoop = {
  ordinal: number;
  summary: string;
  sourceQuote: string;
  confidence: number;
};

export function buildPrivateLoopReply(input: {
  extraction: LoopExtractionResult;
  loops: PrivateReplyLoop[];
}): string {
  if (input.extraction.clarifyingQuestion && input.loops.every((loop) => loop.confidence < 0.7)) {
    return [
      input.extraction.clarifyingQuestion,
      "",
      "Reply yes, no, or edit the loop.",
    ].join("\n");
  }

  if (input.loops.length === 0) {
    return [
      "I did not find a clear loop.",
      "",
      "Reply with what you want me to track.",
    ].join("\n");
  }

  return [
    `I found ${input.loops.length} loop${input.loops.length === 1 ? "" : "s"}.`,
    "",
    ...input.loops.map((loop) => `${loop.ordinal}. ${loop.summary}`),
    "",
    "Reply with:",
    "- correct",
    "- confirm",
    "- dismiss 1",
    "- remind me Thursday",
    "- mark 2 done",
  ].join("\n");
}

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { extractLoops } from "@/agent/extract-loops";
import { matchLoops } from "@/agent/eval/matcher";
import { loadCases } from "@/agent/eval/load-cases";
import type { EvalCase, MatchResult } from "@/agent/eval/types";

export type EvalMode = "deterministic" | "model";

export type CliOptions = {
  mode: EvalMode;
  filter: string | null;
  out: string | null;
  updateBaseline: boolean;
  json: boolean;
};

export type Baseline = {
  precision: number;
  recall: number;
};

/**
 * Per-case scoring result the report and aggregator both consume. `result` is
 * null only when extraction itself fails — never in normal operation.
 */
export type CaseScore = {
  id: string;
  predictedCount: number;
  expectedCount: number;
  result: MatchResult;
  /** true when every predicted loop has confidence < 0.7 (the low-confidence regime). */
  allLowConfidence: boolean;
  /** the LoopExtractionResult.clarifyingQuestion (null when none was asked). */
  clarifyingQuestion: string | null;
};

export type Aggregate = {
  caseCount: number;
  /** micro-averaged precision over all predictions; null when there were zero predictions across all cases. */
  precision: number | null;
  /** micro-averaged recall over all expected loops; null when there were zero expected loops. */
  recall: number | null;
  /**
   * Of cases whose every predicted loop is low-confidence (<0.7), the fraction that
   * asked a clarifying question. null when no case is in that regime.
   */
  lowConfidenceHandlingRate: number | null;
  /** falsePositives / totalPredictions; null when there were zero predictions. */
  falsePositiveRate: number | null;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  totalPredictions: number;
  totalExpected: number;
};

// ---------------------------------------------------------------------------
// Pure, DB-free, process-free scoring + gate logic (unit-testable).
// ---------------------------------------------------------------------------

export const LOW_CONFIDENCE_THRESHOLD = 0.7;

/**
 * aggregateScores: micro-average per-case MatchResults into suite-level metrics.
 * Pure — no IO, no model, no DB.
 */
export function aggregateScores(scores: CaseScore[]): Aggregate {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let totalPredictions = 0;
  let totalExpected = 0;

  let lowConfCases = 0;
  let lowConfHandled = 0;

  for (const score of scores) {
    truePositives += score.result.truePositives;
    falsePositives += score.result.falsePositives;
    falseNegatives += score.result.falseNegatives;
    totalPredictions += score.predictedCount;
    totalExpected += score.expectedCount;

    // Low-confidence regime: at least one prediction, all of them low-confidence.
    if (score.predictedCount > 0 && score.allLowConfidence) {
      lowConfCases += 1;
      if (score.clarifyingQuestion !== null) {
        lowConfHandled += 1;
      }
    }
  }

  return {
    caseCount: scores.length,
    precision: totalPredictions === 0 ? null : truePositives / totalPredictions,
    recall: totalExpected === 0 ? null : truePositives / totalExpected,
    lowConfidenceHandlingRate: lowConfCases === 0 ? null : lowConfHandled / lowConfCases,
    falsePositiveRate: totalPredictions === 0 ? null : falsePositives / totalPredictions,
    truePositives,
    falsePositives,
    falseNegatives,
    totalPredictions,
    totalExpected,
  };
}

/**
 * gateFailed: the deterministic-mode gate. Returns true (→ exit 1) when precision
 * OR recall is below baseline. A null metric (no predictions / no expected) counts
 * as a failure to surface — you cannot pass a gate you produced no evidence for.
 */
export function gateFailed(aggregate: Aggregate, baseline: Baseline): boolean {
  if (aggregate.precision === null || aggregate.recall === null) {
    return true;
  }
  return aggregate.precision < baseline.precision || aggregate.recall < baseline.recall;
}

/**
 * scoreCase: run extraction on one case and match against its label. The model
 * flag is threaded through from the chosen mode.
 */
export async function scoreCase(evalCase: EvalCase, useModel: boolean): Promise<CaseScore> {
  const extraction = await extractLoops({ email: evalCase.normalized, useModel });
  const result = matchLoops(extraction.loops, evalCase.label.expectedLoops);
  const allLowConfidence =
    extraction.loops.length > 0 && extraction.loops.every((loop) => loop.confidence < LOW_CONFIDENCE_THRESHOLD);

  return {
    id: evalCase.id,
    predictedCount: extraction.loops.length,
    expectedCount: evalCase.label.expectedLoops.length,
    result,
    allLowConfidence,
    clarifyingQuestion: extraction.clarifyingQuestion,
  };
}

// ---------------------------------------------------------------------------
// DB-injectable writer. Skips gracefully when DATABASE_URL is unset.
// ---------------------------------------------------------------------------

export type EvalRunWriter = (row: {
  mode: EvalMode;
  gitSha: string | null;
  modelId: string | null;
  caseCount: number;
  precision: number | null;
  recall: number | null;
  lowConfidenceHandlingRate: number | null;
  falsePositiveRate: number | null;
  summary: unknown;
}) => Promise<void>;

/**
 * defaultEvalRunWriter: lazily imports the DB only when DATABASE_URL is present.
 * Never throws on a missing DB — eval must run with no creds. getDb() is imported
 * dynamically so merely loading this module does not touch env/db.
 */
export const defaultEvalRunWriter: EvalRunWriter = async (row) => {
  if (!process.env.DATABASE_URL) {
    return;
  }
  const [{ getDb }, { evalRuns }] = await Promise.all([import("@/db/client"), import("@/db/schema")]);
  const db = getDb();
  await db.insert(evalRuns).values({
    mode: row.mode,
    gitSha: row.gitSha,
    modelId: row.modelId,
    caseCount: row.caseCount,
    precision: row.precision,
    recall: row.recall,
    lowConfidenceHandlingRate: row.lowConfidenceHandlingRate,
    falsePositiveRate: row.falsePositiveRate,
    summary: row.summary as Record<string, unknown>,
  });
};

// ---------------------------------------------------------------------------
// CLI plumbing.
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: "deterministic",
    filter: null,
    out: null,
    updateBaseline: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--mode": {
        const value = argv[(i += 1)];
        options.mode = value === "model" ? "model" : "deterministic";
        break;
      }
      case "--filter":
        options.filter = argv[(i += 1)] ?? null;
        break;
      case "--out":
        options.out = argv[(i += 1)] ?? null;
        break;
      case "--update-baseline":
        options.updateBaseline = true;
        break;
      case "--json":
        options.json = true;
        break;
      default:
        break;
    }
  }

  return options;
}

function fmt(value: number | null): string {
  return value === null ? "n/a (no predictions)" : value.toFixed(3);
}

export function renderReport(aggregate: Aggregate, scores: CaseScore[], mode: EvalMode): string {
  const lines: string[] = [];
  lines.push(`Keeps eval — mode=${mode}`);
  lines.push(`cases: ${aggregate.caseCount}`);
  lines.push("");
  for (const score of scores) {
    lines.push(
      `  ${score.id}: predicted=${score.predictedCount} expected=${score.expectedCount} ` +
        `tp=${score.result.truePositives} fp=${score.result.falsePositives} fn=${score.result.falseNegatives}`,
    );
  }
  if (scores.length > 0) {
    lines.push("");
  }
  lines.push(`precision:                  ${fmt(aggregate.precision)}`);
  lines.push(`recall:                     ${fmt(aggregate.recall)}`);
  lines.push(`false_positive_rate:        ${fmt(aggregate.falsePositiveRate)}`);
  lines.push(`low_confidence_handling:    ${fmt(aggregate.lowConfidenceHandlingRate)}`);
  return lines.join("\n");
}

async function baselinePath(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "baseline.json");
}

export async function readBaseline(path: string): Promise<Baseline> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as Baseline;
}

function gitSha(): string | null {
  return process.env.GITHUB_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null;
}

/**
 * run: the full CLI body. Returns the process exit code (0 pass, 1 gate fail).
 * The writer is injected so tests never touch a DB.
 */
export async function run(options: CliOptions, writer: EvalRunWriter = defaultEvalRunWriter): Promise<number> {
  const allCases = await loadCases();
  const cases = options.filter
    ? allCases.filter((evalCase) => evalCase.id.startsWith(options.filter!))
    : allCases;

  const useModel = options.mode === "model";
  const scores: CaseScore[] = [];
  for (const evalCase of cases) {
    scores.push(await scoreCase(evalCase, useModel));
  }

  const aggregate = aggregateScores(scores);
  const report = renderReport(aggregate, scores, options.mode);
  const payload = {
    mode: options.mode,
    aggregate,
    cases: scores.map((score) => ({
      id: score.id,
      predicted: score.predictedCount,
      expected: score.expectedCount,
      truePositives: score.result.truePositives,
      falsePositives: score.result.falsePositives,
      falseNegatives: score.result.falseNegatives,
      precision: score.result.precision,
      recall: score.result.recall,
      clarifyingQuestion: score.clarifyingQuestion,
    })),
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${report}\n`);
  }

  if (options.out) {
    await writeFile(options.out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  // Record exactly one eval_runs row per invocation (skips gracefully w/o DB).
  await writer({
    mode: options.mode,
    gitSha: gitSha(),
    modelId: process.env.KEEPS_OPENAI_MODEL ?? null,
    caseCount: aggregate.caseCount,
    precision: aggregate.precision,
    recall: aggregate.recall,
    lowConfidenceHandlingRate: aggregate.lowConfidenceHandlingRate,
    falsePositiveRate: aggregate.falsePositiveRate,
    summary: payload,
  });

  const basePath = await baselinePath();

  if (options.updateBaseline) {
    const next: Baseline = {
      precision: aggregate.precision ?? 0,
      recall: aggregate.recall ?? 0,
    };
    await writeFile(basePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    process.stdout.write(`Updated baseline → precision=${next.precision} recall=${next.recall}\n`);
    return 0;
  }

  // Gate only deterministic mode (model mode is non-deterministic / advisory).
  if (options.mode === "deterministic") {
    if (aggregate.caseCount === 0) {
      process.stdout.write("No cases found — gate skipped (0 cases). Add cases under src/agent/eval/cases/.\n");
      return 0;
    }
    const baseline = await readBaseline(basePath);
    if (gateFailed(aggregate, baseline)) {
      process.stdout.write(
        `GATE FAILED — precision=${fmt(aggregate.precision)} recall=${fmt(aggregate.recall)} ` +
          `below baseline precision=${baseline.precision} recall=${baseline.recall}\n`,
      );
      return 1;
    }
    process.stdout.write("GATE PASSED\n");
  }

  return 0;
}

// Direct-invocation entrypoint. Guarded so importing the module (tests) never runs it.
const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  run(parseArgs(process.argv.slice(2)))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}

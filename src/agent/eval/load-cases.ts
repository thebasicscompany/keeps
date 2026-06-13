import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import type { EvalCase } from "@/agent/eval/types";

/**
 * Dynamically load every labeled eval case from src/agent/eval/cases/*.case.ts.
 *
 * Each case file default-exports a single `EvalCase`. We resolve the cases dir
 * relative to THIS module (not cwd) so the loader works regardless of where the
 * CLI is invoked from. An absent/empty dir yields an empty array — A2's cases
 * land later, and the harness must run cleanly until then.
 */
export async function loadCases(casesDir?: string): Promise<EvalCase[]> {
  const dir = casesDir ?? defaultCasesDir();

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Missing directory → no cases yet.
    return [];
  }

  const caseFiles = entries.filter((name) => name.endsWith(".case.ts")).sort();
  const cases: EvalCase[] = [];

  for (const file of caseFiles) {
    const moduleUrl = pathToFileURL(join(dir, file)).href;
    const mod: { default?: EvalCase } = await import(moduleUrl);
    if (mod.default) {
      cases.push(mod.default);
    }
  }

  return cases;
}

function defaultCasesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "cases");
}

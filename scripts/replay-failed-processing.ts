/**
 * scripts/replay-failed-processing.ts
 *
 * Headless ops CLI to replay (or resolve) a dead-letter row, mirroring the admin
 * route. Shares the exact replay core (src/workflows/replay-failed-processing.ts),
 * so idempotency is preserved identically: a replay re-emits the stored event whose
 * inboundEmailId keys process-email's idempotency guard.
 *
 * Usage:
 *   pnpm replay-failed-processing --id <uuid>            # replay (default)
 *   pnpm replay-failed-processing --id <uuid> --resolve  # resolve instead
 *   pnpm replay-failed-processing --id <uuid> --notes "manual fix"
 *
 * Env: requires DATABASE_URL (and INNGEST_* for a real send). Loads .env.local via
 * @next/env for local runs; in CI/Doppler the vars are already in process.env.
 */

import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import {
  replayFailedProcessing,
  type ReplayAction,
} from "@/workflows/replay-failed-processing";

interface Args {
  id: string | null;
  action: ReplayAction;
  notes: string | null;
}

function parseArgs(argv: string[]): Args {
  let id: string | null = null;
  let action: ReplayAction = "replay";
  let notes: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--id") {
      id = argv[++i] ?? null;
    } else if (arg === "--resolve") {
      action = "resolve";
    } else if (arg === "--replay") {
      action = "replay";
    } else if (arg === "--action") {
      const next = argv[++i];
      if (next === "replay" || next === "resolve") action = next;
    } else if (arg === "--notes") {
      notes = argv[++i] ?? null;
    }
  }

  return { id, action, notes };
}

async function main(): Promise<void> {
  const { id, action, notes } = parseArgs(process.argv.slice(2));

  if (!id) {
    console.error("Usage: replay-failed-processing --id <uuid> [--resolve] [--notes <text>]");
    process.exit(2);
  }

  const result = await replayFailedProcessing({ id, action, actorUserId: null, notes });

  if (!result.ok) {
    console.error(`Failed: ${result.error} (id=${id})`);
    process.exit(1);
  }

  if (result.action === "replay") {
    console.log(
      `Replayed ${result.id}: re-emitted ${result.eventName} (inboundEmailId=${result.inboundEmailId ?? "null"}).`,
    );
  } else {
    console.log(`Resolved ${result.id}.`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

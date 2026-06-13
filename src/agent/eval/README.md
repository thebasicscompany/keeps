# Keeps loop-extraction eval harness

Offline quality gate for `extractLoops`. It runs labeled email cases through the
extractor, matches predicted loops against human ground truth, and reports
precision / recall / false-positive-rate / low-confidence-handling-rate. The
deterministic-mode run is a **hard gate**: it exits non-zero when precision or
recall falls below `baseline.json`.

## Running

```bash
pnpm eval                          # deterministic mode (default), gated
pnpm eval --mode model             # use the model extractor (advisory, NOT gated)
pnpm eval --filter synthetic-      # only cases whose id starts with the prefix
pnpm eval --json                   # machine-readable output
pnpm eval --out report.json        # also write the JSON payload to a file
pnpm eval --update-baseline        # overwrite baseline.json with current numbers
```

- **No creds required.** The default deterministic run needs no `OPENAI_API_KEY`
  and no `DATABASE_URL`. When `DATABASE_URL` is set, one `eval_runs` row is
  recorded per invocation; when it is unset the insert is skipped silently.
- Cases live as code in `src/agent/eval/cases/*.case.ts` (each file default-exports
  one `EvalCase`). The harness reports `0 cases` and skips the gate until cases land.

## CI status (read this)

There is **currently no git remote** for this repository, so `.github/workflows/eval.yml`
does **not** run anywhere today — it is committed for the future, so that adding a
GitHub remote turns on CI enforcement automatically. **Today, `pnpm eval --mode
deterministic` is enforced as a LOCAL pre-deploy gate** (run it before every deploy;
a non-zero exit means do not ship). Do not assume live CI is catching regressions yet.

## The matcher (v1)

`matchLoops` is a normalized-token **Jaccard** matcher:

- `tokenize` = lowercase → strip punctuation → drop a small stop-word list.
- A predicted loop matches an expected loop when **both**:
  1. Jaccard over the summary tokens `>= 0.5`, and
  2. the kind matches **or** is an allowed substitute (`ask <-> commitment`, for
     ownership flips — the same loop seen from opposite sides).
- Confidence band is checked **separately** (it never blocks a match): predicted
  confidence maps `low < 0.5`, `medium < 0.7`, `high >= 0.7`.

**Known limitation:** the matcher is lexical, so synonymous-but-different wording
("ship the slides" vs "send the deck") is a miss. A model-graded matcher
(`gradedMatchLoops`) is stubbed for Phase 6.1 with this rubric: *"Score 1 if same
actionable commitment; 0.5 if same topic but different ownership; 0 otherwise."*

## PII scrubbing: turning real pilot emails into anonymized cases

Real pilot emails are sensitive. **Never** commit a raw pilot email as a case.
Follow this procedure to produce an anonymized `*.case.ts` file:

1. **Capture the normalized payload.** Pull the `NormalizedEmail` for the email
   (it is the `normalized_payload` jsonb on the `eval_cases` review-backlog row, or
   re-normalize the raw Postmark payload locally). Work on a copy.

2. **Replace every real person.** Map each distinct human to a stable pseudonym
   (`Person A`, `Person B`, …). Apply the SAME mapping everywhere the name appears:
   `from.name`, `to[].name`, `cc[].name`, and inline mentions in `subject` /
   `textBody` / `htmlBody`. Consistency matters — owner/requester matching depends
   on it.

3. **Replace every email address** with an `@example.com` address that mirrors the
   pseudonym (`person-a@example.com`). Lowercase them (normalization already does).
   Scrub addresses in `from`, `to`, `cc`, the body, and any quoted/forwarded headers.

4. **Scrub company / product / customer names.** Replace real org names with neutral
   placeholders (`Acme`, `Northstar`, `the vendor`). Keep the placeholder consistent
   across the case so "waiting on Acme" still reads coherently.

5. **Strip secrets and identifiers.** Remove or fake: phone numbers, dollar amounts
   that identify a deal, URLs (replace with `https://example.com/…`), API keys,
   tokens, calendar/meeting links, physical addresses, and any free-text that could
   re-identify a person or account.

6. **Neutralize metadata.** Set `providerMessageId` to a synthetic id
   (`real-case-001`), set `provider` to `"fixture"`, drop real `headers` (keep only
   what a label depends on), and set `receivedAt` to a fixed synthetic timestamp so
   relative-due-date resolution is deterministic.

7. **Preserve the linguistic shape, not the content.** Keep sentence structure,
   commitment phrasing, and ambiguity intact (that is what the extractor is graded
   on) while swapping out every identifying token. Do not "clean up" grammar — the
   real messiness is signal.

8. **Label by hand.** Write the `label` (intent + `expectedLoops` with summary,
   kind, ownerText, requesterText, dueDateText, confidenceBand,
   expectsClarifyingQuestion) against the SCRUBBED text only.

9. **Verify before committing.** Re-read the finished case end to end and grep for
   leftover real domains / names:

   ```bash
   grep -nEi '@(?!example\.com)[a-z0-9.-]+\.[a-z]{2,}' src/agent/eval/cases/your-case.case.ts
   ```

   Zero hits (other than `@example.com`) is the bar. Only then commit.

## Current case inventory

`src/agent/eval/cases/` currently holds **15 synthetic cases** (prefix `synthetic-`)
covering all loopKinds the deterministic extractor can detect, all basis values,
the missing/relative/absolute due-date variants, the empty-body edge case, all five
intent classes (capture / command / approval / correction / question), and the
low-confidence "keep-from-slipping" fallback.

`real-example.case.ts` is a **scaffold** with synthetic content that demonstrates
the format a scrubbed real pilot email would take. It is **not** a real case.

**The remaining ~15 anonymized REAL cases are HUMAN-GATED.**
Arav must supply and scrub them following the procedure above before they can be
committed. Do not fabricate real user content — synthetic wording injected into
a "real" case file defeats the purpose of the eval (measuring extractor quality
against authentic language patterns).

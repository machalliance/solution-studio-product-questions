/**
 * Dev-only prompt-sync check.
 *
 * On dev server boot, pulls each prompt named in `FALLBACK_PROMPTS` from the
 * LangSmith Hub and compares (exact string match) against the in-code
 * fallback. Logs one line per prompt — in sync, drifted, missing, or unreachable.
 *
 * Fire-and-forget: the check runs asynchronously from `instrumentation.ts`
 * and never blocks server startup. Gated on:
 *   - `NODE_ENV === "development"` — prod boots don't generate hub traffic
 *   - `LANGSMITH_API_KEY` present — no point checking if the hub isn't wired
 *
 * What we deliberately *don't* do here: auto-fix drift, fail the server, or
 * warn in prod. Drift is expected between deploys; this is signal for the
 * person running `pnpm dev`, not an operational alert.
 */
import { Client } from "langsmith";
import { FALLBACK_PROMPTS, extractSystemTemplateString } from "./hub";

type CheckStatus =
  | { kind: "in-sync" }
  | { kind: "drifted" }
  | { kind: "missing-in-hub" }
  | { kind: "hub-unreachable"; error: string };

interface CheckResult {
  name: string;
  status: CheckStatus;
}

function shouldRun(): boolean {
  return (
    process.env.NODE_ENV === "development" && !!process.env.LANGSMITH_API_KEY
  );
}

async function checkOne(
  client: Client,
  name: string,
  fallbackTemplate: string,
): Promise<CheckResult> {
  try {
    // Always pull `:latest` for the drift check — we want to know about any
    // edit in the hub, not just what's pinned to the production tag.
    const commit = await client.pullPromptCommit(`${name}:latest`);
    const hubTemplate = extractSystemTemplateString(commit.manifest);
    if (hubTemplate === null) {
      return { name, status: { kind: "missing-in-hub" } };
    }
    return {
      name,
      status:
        hubTemplate === fallbackTemplate
          ? { kind: "in-sync" }
          : { kind: "drifted" },
    };
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    // LangSmith throws a "not found" style error when the prompt doesn't exist.
    if (/not.?found|404/i.test(message)) {
      return { name, status: { kind: "missing-in-hub" } };
    }
    return { name, status: { kind: "hub-unreachable", error: message } };
  }
}

function logResult(result: CheckResult): void {
  const prefix = `[prompt-check] ${result.name}:`;
  switch (result.status.kind) {
    case "in-sync":
      console.log(`${prefix} in sync with hub`);
      return;
    case "drifted":
      console.warn(
        `${prefix} drifted — hub has a different version than the in-code fallback. Run \`pnpm prompts:push --force\` to overwrite the hub, or pull the hub text into FALLBACK_PROMPTS.`,
      );
      return;
    case "missing-in-hub":
      console.warn(
        `${prefix} not found in hub — run \`pnpm prompts:push\` to bootstrap it.`,
      );
      return;
    case "hub-unreachable":
      console.warn(
        `${prefix} could not reach LangSmith (${result.status.error}). App will use the fallback.`,
      );
      return;
  }
}

/**
 * Run the drift check against every prompt in FALLBACK_PROMPTS.
 * Safe to call in any environment — no-ops outside dev.
 */
export async function runPromptSyncCheck(): Promise<void> {
  if (!shouldRun()) return;

  const client = new Client();
  const entries = Object.entries(FALLBACK_PROMPTS);

  console.log(
    `[prompt-check] comparing ${entries.length} prompts against LangSmith...`,
  );

  const results = await Promise.all(
    entries.map(([name, prompt]) => checkOne(client, name, prompt.template)),
  );

  for (const result of results) {
    logResult(result);
  }
}

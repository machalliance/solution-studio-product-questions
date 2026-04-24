/**
 * One-shot push of FALLBACK_PROMPTS to LangSmith Hub.
 *
 * Run once per LangSmith workspace (typically per environment — dev/staging/prod)
 * to bootstrap the hub with the prompts committed in `lib/prompts/hub.ts`.
 *
 * Behaviour:
 *   - For each entry in FALLBACK_PROMPTS:
 *     - If the prompt doesn't exist in the hub → create it + push a first commit.
 *     - If the prompt exists and --force was passed → push a new commit.
 *     - If the prompt exists and --force was NOT passed → skip.
 *   - All commits are accessible via the `:latest` tag automatically.
 *   - Promoting a commit to `:production` (or any other label) is a deliberate
 *     manual step in the LangSmith UI — we don't auto-promote here so the push
 *     script doesn't accidentally overwrite whatever prod is pinned to.
 *
 * Usage:
 *   pnpm prompts:push              # create missing prompts, skip existing
 *   pnpm prompts:push --force      # create missing + push new commits to existing
 *   pnpm prompts:push --dry-run    # print what would happen, make no changes
 *
 * Requires LANGSMITH_API_KEY to be set (read from .env.local via tsx --env-file).
 */
import { Client } from "langsmith";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { FALLBACK_PROMPTS, type PromptTemplate } from "@/server/prompts/hub";

interface Args {
  force: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  return {
    force: argv.includes("--force"),
    dryRun: argv.includes("--dry-run"),
  };
}

/**
 * Builds a LangChain-serialized ChatPromptTemplate. LangSmith's `pushPrompt`
 * validates the manifest against LangChain's serialization schema (it must
 * carry the `lc`/`type`/`id` envelope), so a plain `{ messages: [...] }`
 * object 400s with "Manifest must have an id field". Our `extractTemplate`
 * pull-side helper already understands this format.
 */
function buildManifest(prompt: PromptTemplate) {
  return ChatPromptTemplate.fromMessages([["system", prompt.template]]);
}

async function pushOne(
  client: Client,
  name: string,
  prompt: PromptTemplate,
  args: Args,
): Promise<"created" | "committed" | "unchanged" | "skipped"> {
  const exists = await client.promptExists(name);

  if (exists && !args.force) {
    console.log(`  skip:    ${name} (exists, use --force to push new commit)`);
    return "skipped";
  }

  if (args.dryRun) {
    console.log(
      `  dry-run: ${name} (would ${exists ? "commit new version" : "create + commit"})`,
    );
    return exists ? "committed" : "created";
  }

  let url: string;
  try {
    url = await client.pushPrompt(name, {
      object: buildManifest(prompt),
      description:
        "Managed by push-prompts.ts — do not edit via UI if your team treats code as the source of truth.",
    });
  } catch (error) {
    // LangSmith returns 409 when --force re-commits an unchanged prompt.
    // That's a sensible server-side guard, not a failure — skip and continue.
    const message = (error as Error).message ?? "";
    if (message.includes("Nothing to commit")) {
      console.log(`  noop:    ${name} (unchanged since latest commit)`);
      return "unchanged";
    }
    throw error;
  }

  if (exists) {
    console.log(`  commit:  ${name} → ${url}`);
    return "committed";
  }
  console.log(`  create:  ${name} → ${url}`);
  return "created";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.LANGSMITH_API_KEY) {
    console.error(
      "LANGSMITH_API_KEY is not set — run this from the project root with `.env.local` present.",
    );
    process.exit(1);
  }

  console.log(
    `Pushing ${Object.keys(FALLBACK_PROMPTS).length} prompts to LangSmith Hub` +
      (args.force ? " (force: new commits on existing prompts)" : "") +
      (args.dryRun ? " (dry-run)" : ""),
  );

  const client = new Client();
  const results = { created: 0, committed: 0, unchanged: 0, skipped: 0 };

  for (const [name, prompt] of Object.entries(FALLBACK_PROMPTS)) {
    try {
      const outcome = await pushOne(client, name, prompt, args);
      results[outcome] += 1;
    } catch (error) {
      console.error(`  error:   ${name} — ${(error as Error).message}`);
      throw error;
    }
  }

  console.log("");
  console.log(
    `Done. Created ${results.created}, committed ${results.committed}, unchanged ${results.unchanged}, skipped ${results.skipped}.`,
  );

  if (results.created > 0 || results.committed > 0) {
    console.log("");
    console.log(
      "New commits are live under the `:latest` tag. To promote one to `:production`, open the prompt in the LangSmith UI and add the `production` tag to the commit you want to ship.",
    );
  }
}

main().catch((error) => {
  console.error("Push failed:", error);
  process.exit(1);
});

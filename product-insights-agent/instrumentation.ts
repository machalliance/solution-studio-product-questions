/**
 * Next.js instrumentation — runs once per server boot, before any request.
 * See https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * Current responsibilities:
 *   - In dev only: compare each FALLBACK_PROMPTS entry against LangSmith and
 *     log drift. Fire-and-forget so we never block boot.
 *   - Register server-side event sinks (env-gated).
 */
export async function register(): Promise<void> {
  // Skip the edge runtime — LangSmith client and Node APIs only work in the
  // nodejs runtime, and the check is dev-tooling, not a user-facing feature.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { runPromptSyncCheck } = await import("./src/server/prompts/dev-check");

  // Fire-and-forget — we never want this to delay the dev server coming up
  // or to crash the process on a LangSmith outage.
  runPromptSyncCheck().catch((error) => {
    console.warn("[prompt-check] failed to run:", error);
  });

  const { registerSink } = await import("./src/server/events/sinks");
  const { maybeRegisterAnalyticsSink } =
    await import("./src/server/events/sinks/analytics");
  maybeRegisterAnalyticsSink(registerSink);
}

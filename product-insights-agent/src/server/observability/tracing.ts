import { createHash } from "node:crypto";
import * as ai from "ai";
import { gateway } from "ai";
import { Client } from "langsmith";
import { wrapAISDK } from "langsmith/experimental/vercel";
import { traceable, getCurrentRunTree } from "langsmith/traceable";

/**
 * Whether LangSmith tracing is enabled (requires LANGSMITH_TRACING=true and LANGSMITH_API_KEY).
 */
export function isTracingEnabled(): boolean {
  return (
    process.env.LANGSMITH_TRACING === "true" && !!process.env.LANGSMITH_API_KEY
  );
}

/**
 * LangSmith client singleton — only created when tracing is enabled.
 */
let _client: Client | undefined;

export function getLangSmithClient(): Client | undefined {
  if (!isTracingEnabled()) return undefined;
  if (!_client) {
    _client = new Client();
  }
  return _client;
}

/**
 * Resolves a string model id (e.g. "openai/gpt-5-nano") to a real
 * LanguageModelV2 via the gateway provider. The LangSmith wrapper calls
 * `wrapLanguageModel` on whatever `model` is passed in, and that helper
 * requires an object with `.doGenerate` — strings explode at runtime.
 * AI SDK's own `generateText`/`streamText` resolve strings internally,
 * so this only matters on the traced path.
 */
function resolveModel<T extends { model?: unknown }>(params: T): T {
  if (typeof params.model === "string") {
    return { ...params, model: gateway(params.model) };
  }
  return params;
}

/**
 * Wrapped AI SDK methods with LangSmith tracing.
 * When tracing is disabled, returns the original unwrapped methods.
 */
function createTracedAI() {
  if (!isTracingEnabled()) {
    return {
      generateText: ai.generateText,
      streamText: ai.streamText,
    };
  }

  const client = getLangSmithClient();
  const wrapped = wrapAISDK(ai, {
    client,
    metadata: {
      app: "product-insights-agent",
    },
  });

  const tracedGenerateText: typeof ai.generateText = (params, ...rest) =>
    wrapped.generateText(resolveModel(params), ...rest);

  const tracedStreamText: typeof ai.streamText = (params, ...rest) =>
    wrapped.streamText(resolveModel(params), ...rest);

  return {
    generateText: tracedGenerateText,
    streamText: tracedStreamText,
  };
}

// Lazy-initialized traced AI methods
let _tracedAI: ReturnType<typeof createTracedAI> | undefined;

export function getTracedAI() {
  if (!_tracedAI) {
    _tracedAI = createTracedAI();
  }
  return _tracedAI;
}

/**
 * Wraps a function with LangSmith traceable for custom span tracing.
 * When tracing is disabled, returns the original function.
 */
export function traceFunction<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  F extends (...args: any[]) => any,
>(fn: F, options: { name: string; metadata?: Record<string, string> }): F {
  if (!isTracingEnabled()) return fn;

  return traceable(fn, {
    name: options.name,
    metadata: options.metadata,
    client: getLangSmithClient(),
    run_type: "chain",
  }) as unknown as F;
}

/**
 * Flushes pending trace batches. Call in serverless environments (e.g. Next.js `after()`)
 * to ensure traces are sent before the function shuts down.
 */
export async function flushTraces(): Promise<void> {
  const client = getLangSmithClient();
  if (client) {
    await client.awaitPendingTraceBatches();
  }
}

/**
 * Attach key/value metadata to the current traceable span, if tracing is
 * enabled and we're inside a traceable. No-op otherwise.
 *
 * Used from the chat route to record decision-level context (guardrail
 * triggers, classification results, retrieved chunk IDs/scores) so traces
 * carry the information — not just console.log.
 */
export function attachRunMetadata(extra: Record<string, unknown>): void {
  if (!isTracingEnabled()) return;
  try {
    const run = getCurrentRunTree(true);
    if (!run) return;
    run.metadata = { ...(run.metadata ?? {}), ...extra };
  } catch {
    // Outside a traceable context — silently ignore
  }
}

/**
 * SHA-256 hex digest of a user input. Used to record blocked-request inputs
 * in traces without writing the raw payload — a detected injection string
 * must never land in a sink that an LLM-based summarizer might re-read.
 */
export function hashUserInput(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

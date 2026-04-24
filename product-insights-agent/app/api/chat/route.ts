import { after } from "next/server";
import { NextResponse } from "next/server";
import { buildCorsHeaders } from "@/server/cors";
import { checkEmbedAuth } from "@/server/auth";

const CORS_METHODS = "POST, OPTIONS";

export function OPTIONS(req: Request) {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(req, { methods: CORS_METHODS }),
  });
}
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessageChunk,
} from "ai";
import { retrieveChunks } from "@/server/retrieval";
import {
  buildSystemPrompt,
  buildUserMessage,
  formatProductContext,
} from "@/server/prompt";
import { FileProductDataAdapter } from "@/server/product/file-adapter";
import { config } from "@/server/config";
import { checkPatternGuard } from "@/server/guardrails/pattern-guard";
import { classifyForEscalation } from "@/server/guardrails/escalation";
import { checkPostResponse } from "@/server/guardrails/post-check";
import {
  getTracedAI,
  flushTraces,
  attachRunMetadata,
  hashUserInput,
  traceFunction,
} from "@/server/observability/tracing";

const CHAT_MODEL = "openai/gpt-5-mini";

const productAdapter = new FileProductDataAdapter();

// Per-phase timing breadcrumbs are useful while developing but redundant in
// prod — LangSmith spans already carry the same information via
// `attachRunMetadata`. Gate them behind NODE_ENV so serverless logs stay clean.
const devLog = (...args: unknown[]) => {
  if (process.env.NODE_ENV !== "production") console.log(...args);
};

function timed<T>(
  label: string,
  rid: string,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = performance.now();
  return fn().then(
    (result) => {
      const dt = (performance.now() - t0).toFixed(0);
      devLog(`[chat ${rid}] ${label} ok ${dt}ms`);
      return result;
    },
    (err) => {
      const dt = (performance.now() - t0).toFixed(0);
      devLog(`[chat ${rid}] ${label} err ${dt}ms`);
      throw err;
    },
  );
}

type PrepareResult =
  | { kind: "blocked"; reason: string }
  | { kind: "escalated"; message: string; category: string }
  | {
      kind: "answer";
      systemPrompt: string;
      contextMessage: string;
    };

/**
 * Pre-stream pipeline: guardrails, retrieval, classification, prompt build.
 * Wrapped in `traceFunction` so the root LangSmith span carries all the
 * decision metadata (guardrail trigger, classifier output, retrieved chunk
 * IDs/scores) via `attachRunMetadata`.
 *
 * Raw `user_question` is only attached to the span after the deterministic
 * guard clears the request. Blocked requests carry only a length + SHA-256
 * hash, so LLM-based trace summarizers never see injection payloads.
 */
async function prepareAnswer(
  userQuestion: string,
  productId: string,
  rid: string,
  since: () => string,
): Promise<PrepareResult> {
  attachRunMetadata({
    request_id: rid,
    productId,
    user_question_length: userQuestion.length,
    user_question_sha256: hashUserInput(userQuestion),
  });

  // Layer 1: Input validation — deterministic regex, OWASP LLM01.
  const patternResult = checkPatternGuard(userQuestion);
  if (patternResult.blocked) {
    attachRunMetadata({
      guardrail_blocked: true,
      guardrail_category: patternResult.category,
      guardrail_reason: patternResult.reason,
      guardrail_pattern: patternResult.pattern,
    });
    // Brand-voice overrides are a soft block handled by the escalation
    // path. Security blocks return a 400 from the outer handler.
    if (patternResult.category === "brand-voice") {
      return {
        kind: "escalated",
        message: config.escalation.message,
        category: "style-override",
      };
    }
    return { kind: "blocked", reason: patternResult.reason ?? "blocked" };
  }

  // Guard cleared — raw user input is safe to attach to the trace from here
  // on, since this request will reach an LLM anyway.
  attachRunMetadata({ user_question: userQuestion });

  // Layer 3: LLM escalation classifier. Runs in parallel with retrieval so
  // its latency is hidden behind the vector search round-trip. Safety routing
  // must never be skipped by a heuristic — regex can't reason about meaning
  // ("it ran over my dog" is a harm report, not a product question).
  devLog(`[chat ${rid}] t+${since()}ms parallel-block start`);

  const [product, chunks, escalation] = await Promise.all([
    timed("product", rid, () => productAdapter.getProduct(productId)),
    timed("retrieval", rid, () => retrieveChunks(userQuestion, { productId })),
    timed("classifier", rid, () => classifyForEscalation(userQuestion)),
  ]);
  devLog(
    `[chat ${rid}] t+${since()}ms parallel-block done chunks=${chunks.length}`,
  );

  attachRunMetadata({
    product_info: formatProductContext(product),
    retrieved_chunk_count: chunks.length,
    retrieved_chunks: chunks.map((c, i) => ({
      rank: i + 1,
      score: Number(c.score.toFixed(4)),
      section: c.metadata.sectionHeader,
      pages: c.metadata.pageNumbers,
      chunk_index: c.metadata.chunkIndex,
      text: c.text,
    })),
    classification: {
      escalated: escalation.escalated,
      category: escalation.category ?? null,
      reasoning: escalation.reasoning ?? null,
    },
  });

  if (escalation.failed) {
    attachRunMetadata({
      classifier_failed: true,
      classifier_fail_reason: escalation.failReason,
    });
  }

  if (escalation.escalated) {
    return {
      kind: "escalated",
      message: escalation.message ?? config.escalation.message,
      category: escalation.category ?? "unknown",
    };
  }

  const systemPrompt = await buildSystemPrompt(product);
  const contextMessage = buildUserMessage(product, chunks, userQuestion);
  devLog(
    `[chat ${rid}] t+${since()}ms prompt-built system=${systemPrompt.length}ch user=${contextMessage.length}ch`,
  );

  return { kind: "answer", systemPrompt, contextMessage };
}

const tracedPrepareAnswer = traceFunction(prepareAnswer, {
  name: "chat-prepare",
});

export async function POST(req: Request) {
  const rid = Math.random().toString(36).slice(2, 8);
  const tStart = performance.now();
  const since = () => (performance.now() - tStart).toFixed(0);
  devLog(`[chat ${rid}] request start`);

  const corsHeaders = buildCorsHeaders(req, { methods: CORS_METHODS });

  const authFailure = checkEmbedAuth(req);
  if (authFailure) {
    return NextResponse.json(authFailure.body, {
      status: authFailure.status,
      headers: corsHeaders,
    });
  }

  let body: { message: string; productId?: unknown };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: corsHeaders },
    );
  }

  const { message, productId: rawProductId } = body;

  if (!message || typeof message !== "string" || !message.trim()) {
    return NextResponse.json(
      { error: "message is required and must be a non-empty string" },
      { status: 400, headers: corsHeaders },
    );
  }

  // productId is trust-from-client for the demo; it's already exposed on the
  // PDP URL. In production the server would resolve it from signed page
  // context — see docs/production-scaling/.
  let productId: string;
  if (rawProductId === undefined || rawProductId === null) {
    productId = config.product.defaultProductId;
  } else if (typeof rawProductId === "string" && rawProductId.trim()) {
    productId = rawProductId.trim();
  } else {
    return NextResponse.json(
      { error: "productId must be a non-empty string when provided" },
      { status: 400, headers: corsHeaders },
    );
  }

  const userQuestion = message.trim();

  // Input length cap — OWASP LLM04 (Model Denial of Service). Prevents
  // oversized inputs from inflating cost or latency on a public endpoint.
  if (userQuestion.length > config.chat.maxInputLength) {
    return NextResponse.json(
      { error: "Message exceeds maximum length" },
      { status: 400, headers: corsHeaders },
    );
  }

  let prepared: PrepareResult;
  try {
    prepared = await tracedPrepareAnswer(userQuestion, productId, rid, since);
  } catch (error) {
    console.error(`[chat ${rid}] prepare error at t+${since()}ms:`, error);
    return NextResponse.json(
      { error: config.chat.errorMessage },
      { status: 500, headers: corsHeaders },
    );
  }

  if (prepared.kind === "blocked") {
    return NextResponse.json(
      { error: config.chat.errorMessage },
      { status: 400, headers: corsHeaders },
    );
  }

  if (prepared.kind === "escalated") {
    // Stream the escalation copy back as assistant text so the widget's
    // existing render path picks it up unchanged. Carries the category in
    // a response header for observability and metrics.
    const { message, category } = prepared;
    const stream = createUIMessageStream({
      execute({ writer }) {
        const textId = `escalation-${rid}`;
        const chunks: UIMessageChunk[] = [
          { type: "start" },
          { type: "start-step" },
          { type: "text-start", id: textId },
          { type: "text-delta", id: textId, delta: message },
          { type: "text-end", id: textId },
          { type: "finish-step" },
          { type: "finish" },
        ];
        for (const chunk of chunks) writer.write(chunk);
      },
    });

    after(async () => {
      await flushTraces();
    });

    return createUIMessageStreamResponse({
      stream,
      headers: { ...corsHeaders, "x-escalation-category": category },
    });
  }

  const { systemPrompt, contextMessage } = prepared;

  try {
    const { streamText } = getTracedAI();

    const tStream = performance.now();
    let firstChunkLogged = false;
    const result = streamText({
      model: CHAT_MODEL,
      system: systemPrompt,
      messages: [{ role: "user", content: contextMessage }],
      providerOptions: {
        openai: { reasoningEffort: "minimal" },
      },
      onChunk() {
        if (!firstChunkLogged) {
          firstChunkLogged = true;
          const dt = (performance.now() - tStream).toFixed(0);
          devLog(
            `[chat ${rid}] t+${since()}ms first-chunk (stream-latency ${dt}ms)`,
          );
        }
      },
      // Layer 4: Post-response grounding check (runs after streaming completes)
      onFinish({ text }) {
        devLog(`[chat ${rid}] t+${since()}ms stream finish`);
        const postCheck = checkPostResponse(text);
        attachRunMetadata({
          post_check_passed: postCheck.passed,
          post_check_violations: postCheck.violations,
          response_length: text.length,
        });
      },
    });
    devLog(`[chat ${rid}] t+${since()}ms streamText returned`);

    // Flush LangSmith traces in serverless context
    after(async () => {
      await flushTraces();
    });

    return result.toUIMessageStreamResponse({ headers: corsHeaders });
  } catch (error) {
    console.error(`[chat ${rid}] stream error at t+${since()}ms:`, error);
    return NextResponse.json(
      { error: config.chat.errorMessage },
      { status: 500, headers: corsHeaders },
    );
  }
}

import { Output } from "ai";
import { z } from "zod";
import { config } from "@/server/config";
import { getTracedAI } from "@/server/observability/tracing";
import { wrapUserInput } from "@/server/prompt";
import { pullPrompt, applyTemplate, PROMPT_NAMES } from "@/server/prompts/hub";

const CLASSIFIER_MODEL = "openai/gpt-5-nano";
const CLASSIFIER_TIMEOUT_MS = 1500;
const CLASSIFIER_MAX_ATTEMPTS = 2;

class ClassifierTimeoutError extends Error {
  constructor() {
    super("classifier timed out");
    this.name = "ClassifierTimeoutError";
  }
}

export type ClassifierFailReason = "timeout" | "error" | "parse";

export const SENSITIVE_CATEGORIES = [
  "safety-hazard",
  "safety-incident",
  "warranty-claim",
  "competitor-comparison",
  "pricing-dispute",
  "repair-request",
  "legal-inquiry",
] as const;

export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

const classificationSchema = z.object({
  isSensitive: z
    .boolean()
    .describe("Whether the question falls into a sensitive category"),
  category: z
    .enum([...SENSITIVE_CATEGORIES, "none"])
    .describe("The sensitive category, or 'none' if not sensitive"),
  reasoning: z
    .string()
    .describe("Brief one-sentence explanation of the classification"),
});

export type Classification = z.infer<typeof classificationSchema>;

export interface EscalationResult {
  escalated: boolean;
  category?: SensitiveCategory | "unknown";
  message?: string;
  reasoning?: string;
  failed?: boolean;
  failReason?: ClassifierFailReason;
}

/**
 * Runs `generateText` with a hard timeout via AbortController. Rejects with
 * `ClassifierTimeoutError` if the timer fires before the call resolves.
 */
async function generateWithTimeout(
  generateText: ReturnType<typeof getTracedAI>["generateText"],
  systemPrompt: string,
  userQuestion: string,
  timeoutMs: number,
) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await generateText({
      model: CLASSIFIER_MODEL,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Classify this customer question:\n\n${wrapUserInput(userQuestion)}`,
        },
      ],
      experimental_output: Output.object({
        schema: classificationSchema,
      }),
      providerOptions: {
        openai: { reasoningEffort: "minimal" },
      },
      abortSignal: controller.signal,
    });
  } catch (err) {
    if (timedOut) throw new ClassifierTimeoutError();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function failClosed(reason: ClassifierFailReason): EscalationResult {
  return {
    escalated: true,
    category: "unknown",
    message: config.escalation.message,
    reasoning: "classifier failure — fail-closed to human escalation",
    failed: true,
    failReason: reason,
  };
}

/**
 * Layer 3: LLM-based classification for sensitive topics.
 * Uses a fast LLM call to classify whether a question should be escalated.
 *
 * Pulls the `product-insights-agent-escalation-classifier` prompt from LangSmith Hub at runtime,
 * falling back to the hardcoded template in `lib/prompts/hub.ts` if the hub
 * is unreachable or tracing is disabled.
 *
 * Fails closed: on timeout or thrown error, retries once; on final failure
 * (or a deterministic parse failure), returns an escalation with the generic
 * support message rather than letting the caller answer from the product
 * manual. A false-positive escalation is cheap; a missed safety incident is
 * not. Parse failure is not retried — identical input will parse-fail again.
 */
export async function classifyForEscalation(
  userQuestion: string,
): Promise<EscalationResult> {
  const { generateText } = getTracedAI();

  const prompt = await pullPrompt(PROMPT_NAMES.ESCALATION_CLASSIFIER);
  const systemPrompt = applyTemplate(prompt, {});

  let lastReason: ClassifierFailReason = "error";

  for (let attempt = 1; attempt <= CLASSIFIER_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await generateWithTimeout(
        generateText,
        systemPrompt,
        userQuestion,
        CLASSIFIER_TIMEOUT_MS,
      );

      const classification = result.experimental_output;
      if (!classification) {
        return failClosed("parse");
      }

      if (!classification.isSensitive) {
        return { escalated: false };
      }

      const category = classification.category as SensitiveCategory;
      return {
        escalated: true,
        category,
        message: getEscalationMessage(category),
        reasoning: classification.reasoning,
      };
    } catch (err) {
      lastReason = err instanceof ClassifierTimeoutError ? "timeout" : "error";
    }
  }

  return failClosed(lastReason);
}

/**
 * Returns the escalation response message for a given sensitive category.
 * All copy is sourced from the centralized config.
 *
 * `safety-incident` gets a distinct message: empathetic acknowledgment +
 * explicit handoff to human support. The generic copy is wrong here because
 * it frames the handoff as "I'd be happy to help, but…" which reads as
 * dismissive when someone reports harm.
 */
export function getEscalationMessage(category: SensitiveCategory): string {
  if (category === "safety-incident") {
    return config.escalation.safetyIncidentMessage;
  }
  return config.escalation.message;
}

/**
 * Layer 4: Output validation (OWASP LLM05: Improper Output Handling).
 *
 * Deterministic post-generation scan. In this demo, violations are logged
 * but the response still streams to the user — this is an observability
 * control, not an enforcement gate. Blocking would leave the user with no
 * answer on a false positive, which is worse UX than a logged warning.
 *
 * In production you'd add a real blocking output filter (Llama Guard, a
 * moderation API, or a second deterministic pass that rewrites before
 * first-token). See ../../../docs/production-scaling/guardrails.md.
 */

export interface PostCheckResult {
  passed: boolean;
  violations: PostCheckViolation[];
}

export interface PostCheckViolation {
  type:
    | "competitor-mention"
    | "unsupported-safety-claim"
    | "length-exceeded"
    | "format-violation";
  detail: string;
}

/**
 * Known competitor brand names for the robot vacuum category.
 * Used to detect when an AI response mentions competitors.
 */
const COMPETITOR_BRANDS = [
  "roomba",
  "irobot",
  "roborock",
  "ecovacs",
  "deebot",
  "shark",
  "samsung",
  "lg",
  "dyson",
  "eufy",
  "neato",
  "xiaomi",
  "tineco",
  "bissell",
  "narwal",
];

/**
 * Patterns indicating unsupported safety claims in responses.
 * These go beyond what product documentation would state.
 */
const UNSUPPORTED_SAFETY_PATTERNS: { regex: RegExp; detail: string }[] = [
  {
    regex: /\b(guaranteed|100%)\s+(safe|secure|risk[- ]?free)\b/i,
    detail: "Absolute safety guarantee",
  },
  {
    regex: /\b(no|zero)\s+(risk|danger|hazard)\b/i,
    detail: "Absolute safety claim (no risk/danger)",
  },
  {
    regex:
      /\bwill\s+not\s+(cause|result\s+in)\s+(any\s+)?(harm|injury|damage|fire)\b/i,
    detail: "Absolute safety assurance against harm",
  },
  {
    regex: /\b(certified|approved)\s+(safe|compliant)\s+by\b/i,
    detail: "Unverified certification claim",
  },
  {
    regex: /\bcannot\s+(catch\s+fire|explode|overheat|shock)\b/i,
    detail: "Absolute safety claim against failure modes",
  },
];

/** Maximum response length in characters */
const MAX_RESPONSE_LENGTH = 4000;

/**
 * Layer 4: Post-response grounding check.
 * Validates that the AI's response stays within acceptable bounds:
 * - No competitor brand mentions
 * - No unsupported safety claims
 * - Length/format compliance
 */
export function checkPostResponse(response: string): PostCheckResult {
  const violations: PostCheckViolation[] = [];
  const responseLower = response.toLowerCase();

  // Check for competitor mentions
  for (const brand of COMPETITOR_BRANDS) {
    if (responseLower.includes(brand)) {
      violations.push({
        type: "competitor-mention",
        detail: `Response mentions competitor: ${brand}`,
      });
    }
  }

  // Check for unsupported safety claims
  for (const { regex, detail } of UNSUPPORTED_SAFETY_PATTERNS) {
    if (regex.test(response)) {
      violations.push({
        type: "unsupported-safety-claim",
        detail,
      });
    }
  }

  // Check length constraints
  if (response.length > MAX_RESPONSE_LENGTH) {
    violations.push({
      type: "length-exceeded",
      detail: `Response length (${response.length}) exceeds maximum (${MAX_RESPONSE_LENGTH})`,
    });
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

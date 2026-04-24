/**
 * Layer 1: Input validation (OWASP LLM01: Prompt Injection).
 *
 * Deterministic, pre-LLM regex check. Two distinct categories:
 *   - SECURITY_PATTERNS — prompt-injection / jailbreak attempts.
 *   - BRAND_VOICE_PATTERNS — off-brand style overrides (pirate speak,
 *     ALL CAPS, emoji-only). Not a security control; protects tone.
 *
 * Deterministic controls can't themselves be jailbroken, which is why
 * OWASP and NIST AI RMF recommend them as the first line of defense.
 * See ../../../docs/production-scaling/guardrails.md for the blocking
 * output filters, PII redaction, and rate limiting we'd layer in prod.
 */

export type PatternCategory = "security" | "brand-voice";

export interface PatternGuardResult {
  blocked: boolean;
  category?: PatternCategory;
  reason?: string;
  pattern?: string;
}

const ZERO_WIDTH_CHARS = /[​‌‍‎‏﻿⁠⁡⁢⁣⁤]/;

/**
 * SECURITY_PATTERNS — detect prompt injection, role manipulation, system-
 * prompt extraction, delimiter injection, and code-execution payloads.
 * Mapped to OWASP LLM01 (Prompt Injection).
 */
const SECURITY_PATTERNS: { regex: RegExp; reason: string }[] = [
  // Instruction overrides
  {
    regex:
      /ignore\s+(all\s+)?(previous|prior|above|earlier|preceding)\s+(instructions?|prompts?|rules?|directions?)/i,
    reason: "Instruction override attempt",
  },
  {
    regex:
      /disregard\s+(all\s+|your\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|guidelines?)/i,
    reason: "Instruction override attempt",
  },
  {
    regex: /forget\s+(all\s+)?(previous|prior|your)\s+(instructions?|rules?)/i,
    reason: "Instruction override attempt",
  },
  {
    regex:
      /override\s+(all\s+)?(system|previous|prior)\s+(instructions?|prompts?|rules?)/i,
    reason: "Instruction override attempt",
  },
  {
    regex:
      /do\s+not\s+follow\s+(your|any|the)\s+(previous|prior|system)\s+(instructions?|rules?|prompts?)/i,
    reason: "Instruction override attempt",
  },
  {
    regex: /new\s+instructions?:\s/i,
    reason: "Instruction override attempt",
  },

  // Role manipulation
  {
    regex: /you\s+are\s+now\s+(a|an|the|my)\s+/i,
    reason: "Role manipulation attempt",
  },
  {
    regex: /act\s+as\s+(a|an|if\s+you\s+are|though\s+you\s+are)\s+/i,
    reason: "Role manipulation attempt",
  },
  {
    regex: /pretend\s+(to\s+be|you\s+are|you're)\s+/i,
    reason: "Role manipulation attempt",
  },
  {
    regex:
      /switch\s+(to|into)\s+(a\s+different|another|new)\s+(role|mode|persona)/i,
    reason: "Role manipulation attempt",
  },
  {
    regex: /enter\s+(developer|admin|god|debug|sudo|root|DAN)\s+mode/i,
    reason: "Role manipulation attempt",
  },

  // System prompt extraction
  {
    regex:
      /(show|reveal|display|print|output|repeat|echo|dump|leak|extract)\s+(me\s+)?(the|your|initial|original|system)(\s+(the|your|initial|original|system))*\s+(prompt|instructions?|rules?|guidelines?|message)/i,
    reason: "System prompt extraction attempt",
  },
  {
    regex:
      /tell\s+me\s+(your|the)\s+(system\s+)?(prompt|instructions?|rules?|guidelines?)/i,
    reason: "System prompt extraction attempt",
  },
  {
    regex:
      /what\s+(are|is)\s+(your|the)\s+(system\s+)?(instructions?|prompt|rules?|guidelines?)/i,
    reason: "System prompt extraction attempt",
  },

  // Delimiter injection
  { regex: /<\/?system>/i, reason: "Delimiter injection attempt" },
  { regex: /```\s*system/i, reason: "Delimiter injection attempt" },
  { regex: /\[SYSTEM\]/i, reason: "Delimiter injection attempt" },
  {
    regex: /###\s*(SYSTEM|INSTRUCTION|ADMIN)/i,
    reason: "Delimiter injection attempt",
  },

  // Code execution payloads
  { regex: /\beval\s*\(/i, reason: "Code execution attempt" },
  { regex: /\bexec\s*\(/i, reason: "Code execution attempt" },
  { regex: /\bFunction\s*\(/i, reason: "Code execution attempt" },
];

/**
 * BRAND_VOICE_PATTERNS — off-brand style overrides. Not a security control:
 * these are blocked because a product-page assistant should answer in brand
 * voice, not in pirate speak. Handled via the escalation path, not a 400.
 */
const BRAND_VOICE_PATTERNS: { regex: RegExp; reason: string }[] = [
  {
    regex:
      /\b(respond|reply|answer|talk|speak|write)\s+(in|like|as)\s+(a\s+)?(pirate|yoda|shakespeare(an)?|haiku|limerick|rhymes?|all\s*caps|uppercase|emoji)\b/i,
    reason: "Stylistic override attempt",
  },
  {
    regex: /\b(use|only)\s+emoj(i|is)\b/i,
    reason: "Stylistic override attempt",
  },
];

/**
 * Detects repetition attacks where attackers flood the input with a repeated
 * phrase to overwhelm instructions. Deliberately simple: long char runs and
 * single-word flooding cover the obvious shapes without false-positive'ing
 * on natural emphasis ("really really good").
 */
function detectRepetition(input: string): boolean {
  const lower = input.toLowerCase();

  // Long runs of the same character (e.g. "aaaaaaaaaa", "!!!!!!!!!!!")
  if (/([a-z0-9!?.,*#$%^&+=-])\1{9,}/i.test(lower)) return true;

  // Single-word flooding: same word 6+ times in a row
  const words = lower.split(/\s+/).filter(Boolean);
  if (words.length < 6) return false;

  let run = 1;
  for (let i = 1; i < words.length; i++) {
    if (words[i] === words[i - 1]) {
      run += 1;
      if (run >= 6) return true;
    } else {
      run = 1;
    }
  }
  return false;
}

/**
 * Plain normalization: strip zero-width chars, collapse whitespace.
 * Catches the most common obfuscation tricks without being destructive.
 */
function normalizeInput(input: string): string {
  return input
    .replace(/[​‌‍‎‏﻿⁠⁡⁢⁣⁤]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Homoglyph map: Cyrillic/Greek lookalikes for ASCII letters that appear
 * in the keywords we care about (ignore, system, instructions, etc.). Not
 * exhaustive — production stacks use a full Unicode confusables table.
 */
const HOMOGLYPH_MAP: Record<string, string> = {
  А: "a",
  а: "a",
  В: "b",
  е: "e",
  Е: "e",
  о: "o",
  О: "o",
  р: "p",
  с: "c",
  С: "c",
  х: "x",
  Х: "x",
  у: "y",
  У: "y",
  і: "i",
  І: "i",
  н: "h",
  ο: "o",
  Ο: "o",
  α: "a",
  Ε: "e",
};

/** Leetspeak substitutions. */
const LEET_MAP: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
  "!": "i",
  "|": "i",
};

/**
 * Aggressive normalization — defeats homoglyph, leetspeak, fullwidth, and
 * spaced-letter obfuscation. Used alongside plain normalization so both
 * "ignore all previous instructions" and "ign0re  аll  p r e v i o u s  …"
 * hit the same pattern set.
 */
function aggressiveNormalize(input: string): string {
  let s = input.normalize("NFKD");
  s = s.replace(/[̀-ͯ]/g, "");
  s = s.replace(/[​‌‍‎‏﻿⁠⁡⁢⁣⁤]/g, "");
  s = s.replace(/[Ѐ-ӿͰ-Ͽ]/g, (ch) => HOMOGLYPH_MAP[ch] ?? ch);
  s = s.toLowerCase();
  s = s.replace(/[014357@$!|]/g, (ch) => LEET_MAP[ch] ?? ch);
  s = s.replace(/(?:\b[a-z]\s){2,}[a-z]\b/g, (m) => m.replace(/\s+/g, ""));
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Runs a pattern set against both normalized variants. Returns the first
 * match; blocks from the aggressive pass carry an `(obfuscated)` suffix
 * so traces can tell which variant fired.
 */
function matchPatterns(
  patterns: { regex: RegExp; reason: string }[],
  plain: string,
  aggressive: string,
  category: PatternCategory,
): PatternGuardResult | null {
  for (const { regex, reason } of patterns) {
    if (regex.test(plain)) {
      return { blocked: true, category, reason, pattern: regex.source };
    }
    if (aggressive !== plain && regex.test(aggressive)) {
      return {
        blocked: true,
        category,
        reason: `${reason} (obfuscated)`,
        pattern: regex.source,
      };
    }
  }
  return null;
}

/**
 * Layer 1: Input validation. Runs security patterns first, then brand-voice
 * patterns. A security block surfaces as a 400; a brand-voice block is soft-
 * handled via the escalation path (see app/api/chat/route.ts).
 */
export function checkPatternGuard(input: string): PatternGuardResult {
  if (ZERO_WIDTH_CHARS.test(input)) {
    return {
      blocked: true,
      category: "security",
      reason: "Zero-width character obfuscation detected",
      pattern: "zero-width",
    };
  }

  if (detectRepetition(input)) {
    return {
      blocked: true,
      category: "security",
      reason: "Repetition attack detected",
      pattern: "repetition",
    };
  }

  const plain = normalizeInput(input);
  const aggressive = aggressiveNormalize(input);

  const security = matchPatterns(
    SECURITY_PATTERNS,
    plain,
    aggressive,
    "security",
  );
  if (security) return security;

  const brandVoice = matchPatterns(
    BRAND_VOICE_PATTERNS,
    plain,
    aggressive,
    "brand-voice",
  );
  if (brandVoice) return brandVoice;

  return { blocked: false };
}

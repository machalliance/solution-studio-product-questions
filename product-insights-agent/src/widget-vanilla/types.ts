export interface SeedQuestion {
  id: string;
  text: string;
  productId: string;
}

export type SeedQuestionsSource = "cache" | "fallback" | "fresh" | "unknown";

export interface WidgetConfig {
  productId: string;
  apiBase?: string;
  container?: HTMLElement;
  clientId?: string;
  /**
   * Shared embed secret. Sent as `Authorization: Bearer <secret>` on every
   * API call. Passed in via the ?secret= URL param when the widget runs in
   * a sandboxed iframe. Safe to expose to the browser in this demo because
   * the storefront hosting the embed is itself behind Vercel Deployment
   * Protection — see docs/production-scaling/embed-security.md.
   */
  secret?: string;
}

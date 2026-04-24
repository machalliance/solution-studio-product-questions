import type { EventSink } from "../sinks";
import type { StoredEvent } from "../buffer";

/**
 * No-op analytics sink. Registered at boot only when ANALYTICS_PROVIDER is set.
 *
 * To ship events to a real collector, replace the forward() body with an HTTP
 * call to your vendor's ingestion endpoint. Common targets:
 *   - Segment           POST https://api.segment.io/v1/track
 *   - Amplitude         POST https://api2.amplitude.com/2/httpapi
 *   - Mixpanel          POST https://api.mixpanel.com/track
 *   - PostHog           POST https://app.posthog.com/capture
 *   - RudderStack       POST https://<dataplane>/v1/track
 *   - GA4 / GTM         POST https://www.google-analytics.com/mp/collect
 *
 * See docs/production-scaling/analytics.md for the full rationale.
 */
export function createAnalyticsSink(provider: string): EventSink {
  return {
    name: `analytics:${provider}`,
    forward(event: StoredEvent) {
      // TODO: implement vendor-specific forwarding.
      // See docs/production-scaling/analytics.md.
      void event;
    },
  };
}

export function maybeRegisterAnalyticsSink(
  register: (sink: EventSink) => () => void,
): void {
  const provider = process.env.ANALYTICS_PROVIDER;
  if (!provider) return;
  register(createAnalyticsSink(provider));
  console.log(`[event-sink] analytics provider registered: ${provider}`);
}

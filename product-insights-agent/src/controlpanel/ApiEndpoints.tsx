"use client";

export function ApiEndpoints() {
  return (
    <div className="mb-6 rounded-lg bg-white p-4 shadow-md">
      <h2 className="mb-3 font-semibold text-zinc-900">API Endpoints</h2>
      <div className="space-y-3 text-sm">
        <div>
          <code className="text-green-600">GET</code>{" "}
          <code className="text-zinc-700">/api/seed-questions</code>
          <p className="mt-1 text-xs text-zinc-500">
            Returns rotated seed questions for a product.
          </p>
        </div>
        <div>
          <code className="text-blue-600">POST</code>{" "}
          <code className="text-zinc-700">/api/chat</code>
          <p className="mt-1 text-xs text-zinc-500">
            Streaming Q&amp;A endpoint backed by RAG + guardrails.
          </p>
        </div>
        <div>
          <code className="text-green-600">GET</code>{" "}
          <code className="text-zinc-700">/api/health</code>
          <p className="mt-1 text-xs text-zinc-500">
            Liveness check for the agent service.
          </p>
        </div>
      </div>
    </div>
  );
}

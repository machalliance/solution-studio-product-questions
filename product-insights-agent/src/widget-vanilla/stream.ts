export async function streamChat(
  endpoint: string,
  body: { message: string; productId: string },
  callbacks: {
    onChunk: (delta: string) => void;
    onDone: (text: string, escalationCategory: string | null) => void;
    onError: (err: Error) => void;
  },
  secret?: string,
): Promise<void> {
  let res: Response;
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (secret) headers["Authorization"] = `Bearer ${secret}`;
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  if (!res.ok) {
    callbacks.onError(new Error(`HTTP ${res.status}`));
    return;
  }

  const escalationCategory = res.headers.get("x-escalation-category");

  const reader = res.body?.getReader();
  if (!reader) {
    callbacks.onError(new Error("No response body"));
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        for (const line of part.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (raw === "[DONE]") {
            callbacks.onDone(fullText, escalationCategory);
            return;
          }
          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(raw);
          } catch {
            continue;
          }
          if (chunk.type === "text-delta" && typeof chunk.delta === "string") {
            fullText += chunk.delta;
            callbacks.onChunk(chunk.delta);
          } else if (chunk.type === "finish") {
            callbacks.onDone(fullText, escalationCategory);
            return;
          }
        }
      }
    }
  } catch (err) {
    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  callbacks.onDone(fullText, escalationCategory);
}

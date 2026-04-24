// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGenerateText } = vi.hoisted(() => ({
  mockGenerateText: vi.fn().mockResolvedValue({
    text: "## Product Manual\n\nExtracted content here.",
  }),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: mockGenerateText,
  };
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import { existsSync, readFileSync, writeFileSync } from "fs";
import { extractToMarkdown, markdownCachePath } from "./extract-markdown";

describe("extractToMarkdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns cached content without API call when cache exists", async () => {
    const cachedMarkdown = "## Cached Content\n\nAlready extracted.";

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(cachedMarkdown);

    const result = await extractToMarkdown("/fake/path.pdf", "test-product");

    expect(result.cached).toBe(true);
    expect(result.markdown).toBe(cachedMarkdown);
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("calls API and caches result when no cache exists", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue(Buffer.from("fake-pdf-content"));

    const result = await extractToMarkdown("/fake/path.pdf", "test-product");

    expect(result.cached).toBe(false);
    expect(result.markdown).toBe(
      "## Product Manual\n\nExtracted content here.",
    );
    expect(mockGenerateText).toHaveBeenCalled();
    expect(writeFileSync).toHaveBeenCalled();
  });

  it("bypasses cache when force option is set", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(Buffer.from("fake-pdf-content"));

    const result = await extractToMarkdown("/fake/path.pdf", "test-product", {
      force: true,
    });

    expect(result.cached).toBe(false);
    expect(mockGenerateText).toHaveBeenCalled();
  });

  it("writes output to the expected cache path", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue(Buffer.from("fake-pdf"));

    await extractToMarkdown("/fake/path.pdf", "my-product");

    const expectedPath = markdownCachePath("my-product");
    expect(expectedPath).toContain("data/markdown/my-product.md");
    expect(writeFileSync).toHaveBeenCalledWith(
      expectedPath,
      expect.any(String),
      "utf-8",
    );
  });

  it("sends the Gemini request with the PDF as a file part and a text instruction", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const buf = Buffer.from("PDF-BYTES");
    vi.mocked(readFileSync).mockReturnValue(buf);

    await extractToMarkdown("/fake/path.pdf", "payload-test");

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const call = mockGenerateText.mock.calls[0][0];
    expect(call.model).toBe("google/gemini-3-pro-preview");
    expect(call.messages).toHaveLength(1);

    const userMessage = call.messages[0];
    expect(userMessage.role).toBe("user");
    expect(Array.isArray(userMessage.content)).toBe(true);
    expect(userMessage.content).toHaveLength(2);

    const filePart = userMessage.content[0];
    expect(filePart.type).toBe("file");
    expect(filePart.mediaType).toBe("application/pdf");
    expect(filePart.data).toBe(buf);

    const textPart = userMessage.content[1];
    expect(textPart.type).toBe("text");
    // The prompt must include the core extraction rules — if someone
    // accidentally truncates or reorders them, this test catches the drift.
    expect(textPart.text).toContain("Markdown");
    expect(textPart.text).toContain("Tables");
    expect(textPart.text).toContain("English");
  });

  it("writes the generated text (a string) to the cache", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue(Buffer.from("pdf"));
    mockGenerateText.mockResolvedValueOnce({
      text: "# New extraction\n\nBody text.",
    });

    await extractToMarkdown("/fake/path.pdf", "utf-check");

    const writeCall = vi.mocked(writeFileSync).mock.calls[0];
    expect(writeCall[1]).toBe("# New extraction\n\nBody text.");
    expect(typeof writeCall[1]).toBe("string");
    expect(writeCall[2]).toBe("utf-8");
  });
});

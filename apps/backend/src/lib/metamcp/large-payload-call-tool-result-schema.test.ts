import { describe, expect, it } from "vitest";

import {
  isStandardBase64,
  LargePayloadCallToolResultSchema,
} from "./large-payload-call-tool-result-schema";

describe("LargePayloadCallToolResultSchema", () => {
  it("accepts a multi-megabyte image without RegExp stack overflow", () => {
    const imageData = "A".repeat(5_826_912);

    const result = LargePayloadCallToolResultSchema.parse({
      content: [
        {
          type: "image",
          data: imageData,
          mimeType: "image/png",
        },
      ],
    });

    expect(result.content[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
    expect(result.content[0]).toHaveProperty("data", imageData);
  });

  it("rejects malformed base64 without using a regular expression", () => {
    expect(isStandardBase64("QUJDRA==")).toBe(true);
    expect(isStandardBase64("QUJD$A==")).toBe(false);
    expect(isStandardBase64("AAA=")).toBe(true);
    expect(isStandardBase64("A===")).toBe(false);
  });

  it("keeps structural validation for binary content blocks", () => {
    const parsed = LargePayloadCallToolResultSchema.safeParse({
      content: [
        {
          type: "image",
          data: 123,
          mimeType: "image/png",
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("retains backwards-compatible toolResult responses", () => {
    expect(
      LargePayloadCallToolResultSchema.parse({
        toolResult: { ok: true },
      }),
    ).toMatchObject({
      toolResult: { ok: true },
    });
  });
});

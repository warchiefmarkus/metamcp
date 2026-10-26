import { z } from "zod";

const MetadataSchema = z.object({}).passthrough().optional();

export function isStandardBase64(value: string): boolean {
  if (value.length % 4 !== 0) {
    return false;
  }

  let dataLength = value.length;
  if (dataLength > 0 && value[dataLength - 1] === "=") {
    dataLength -= 1;
    if (dataLength > 0 && value[dataLength - 1] === "=") {
      dataLength -= 1;
    }
  }

  for (let index = 0; index < dataLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) {
      return false;
    }
  }

  for (let index = dataLength; index < value.length; index += 1) {
    if (value[index] !== "=") {
      return false;
    }
  }

  return true;
}

const LargePayloadBase64Schema = z
  .string()
  .refine(isStandardBase64, "Invalid base64 data");

const TextContentSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
    _meta: MetadataSchema,
  })
  .passthrough();

const ImageContentSchema = z
  .object({
    type: z.literal("image"),
    data: LargePayloadBase64Schema,
    mimeType: z.string(),
    _meta: MetadataSchema,
  })
  .passthrough();

const AudioContentSchema = z
  .object({
    type: z.literal("audio"),
    data: LargePayloadBase64Schema,
    mimeType: z.string(),
    _meta: MetadataSchema,
  })
  .passthrough();

const TextResourceContentsSchema = z
  .object({
    uri: z.string(),
    mimeType: z.string().optional(),
    text: z.string(),
  })
  .passthrough();

const BlobResourceContentsSchema = z
  .object({
    uri: z.string(),
    mimeType: z.string().optional(),
    blob: LargePayloadBase64Schema,
  })
  .passthrough();

const EmbeddedResourceSchema = z
  .object({
    type: z.literal("resource"),
    resource: z.union([
      TextResourceContentsSchema,
      BlobResourceContentsSchema,
    ]),
    _meta: MetadataSchema,
  })
  .passthrough();

const ResourceLinkSchema = z
  .object({
    type: z.literal("resource_link"),
    uri: z.string(),
    name: z.string(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    size: z.number().optional(),
    annotations: z.object({}).passthrough().optional(),
    _meta: MetadataSchema,
  })
  .passthrough();

const ContentBlockSchema = z.discriminatedUnion("type", [
  TextContentSchema,
  ImageContentSchema,
  AudioContentSchema,
  EmbeddedResourceSchema,
  ResourceLinkSchema,
]);

const ResultMetadataSchema = z.object({}).passthrough().optional();

const CallToolResultSchema = z
  .object({
    content: z.array(ContentBlockSchema).default([]),
    structuredContent: z.object({}).passthrough().optional(),
    isError: z.boolean().optional(),
    _meta: ResultMetadataSchema,
  })
  .passthrough();

const LegacyCallToolResultSchema = z
  .object({
    toolResult: z.unknown(),
    _meta: ResultMetadataSchema,
  })
  .passthrough()
  .refine(
    value => Object.prototype.hasOwnProperty.call(value, "toolResult"),
    "Legacy tool result must contain toolResult",
  );

/**
 * MCP SDK 1.16 validates base64 with a regular expression. V8 can overflow
 * its RegExp stack on multi-megabyte screenshots, so binary payloads use an
 * iterative validator while the rest of the result remains schema-checked.
 */
export const LargePayloadCallToolResultSchema = CallToolResultSchema.or(
  LegacyCallToolResultSchema,
);

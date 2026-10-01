import { createHash } from "node:crypto";
import { ValidationError } from "@zentra/domain";
import { z } from "zod";

export const eventTypeSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(
    /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/,
    "Event type must use domain.past_tense_fact format",
  );

export const entityReferenceSchema = z.object({
  type: z.string().min(1).max(100),
  id: z.string().min(1).max(500),
  displayName: z.string().min(1).max(500).optional(),
});
export type EntityReference = z.infer<typeof entityReferenceSchema>;

export const canonicalEventSchema = z.object({
  id: z.uuid(),
  rawEventId: z.uuid(),
  deduplicationKey: z.string().min(1).max(500),
  type: eventTypeSchema,
  schemaVersion: z.number().int().positive(),
  source: z.string().min(1).max(100),
  sourceAccountId: z.string().min(1).max(255).nullable(),
  externalEventId: z.string().min(1).max(500).nullable(),
  occurredAt: z.iso.datetime({ offset: true }),
  receivedAt: z.iso.datetime({ offset: true }),
  actor: entityReferenceSchema.nullable(),
  subject: entityReferenceSchema.nullable(),
  entityRefs: z.array(entityReferenceSchema),
  correlationId: z.string().min(1).max(255).nullable(),
  causationId: z.string().min(1).max(255).nullable(),
  payload: z.record(z.string(), z.unknown()),
  metadata: z
    .object({
      traceId: z.uuid(),
      sensitivity: z.string().min(1).max(100).optional(),
      connectorVersion: z.string().min(1).max(100).optional(),
    })
    .catchall(z.unknown()),
});

export type CanonicalEvent<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> = Omit<z.infer<typeof canonicalEventSchema>, "payload"> & {
  payload: TPayload;
};

export const supportedCanonicalSchemaVersions = new Set([1]);

export const createCanonicalEventId = (
  rawEventId: string,
  deduplicationKey: string,
  schemaVersion: number,
): string => {
  const parsedRawEventId = z.uuid().parse(rawEventId);
  const parsedKey = z.string().min(1).max(500).parse(deduplicationKey);
  const parsedVersion = z.number().int().positive().parse(schemaVersion);
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`${parsedRawEventId}\0${parsedKey}\0${parsedVersion}`)
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const parseCanonicalEvent = (
  input: unknown,
  supportedVersions: ReadonlySet<number> = supportedCanonicalSchemaVersions,
): CanonicalEvent => {
  const parsed = canonicalEventSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Canonical event validation failed", {
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      },
    });
  }
  if (!supportedVersions.has(parsed.data.schemaVersion)) {
    throw new ValidationError("Canonical event schema version is unsupported", {
      details: { schemaVersion: parsed.data.schemaVersion },
    });
  }
  return parsed.data;
};

export const validateCanonicalEvent = (
  input: unknown,
): input is CanonicalEvent => {
  try {
    parseCanonicalEvent(input);
    return true;
  } catch (error: unknown) {
    if (error instanceof ValidationError) return false;
    throw error;
  }
};

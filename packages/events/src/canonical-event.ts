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

import { ValidationError } from "@zentra/domain";
import { eventTypeSchema } from "@zentra/events";
import { z } from "zod";

const sourceEntitySchema = z
  .object({
    type: z.string().min(1).max(100),
    id: z.uuid(),
  })
  .strict();

export const zentraEventEnvelopeSchema = z
  .object({
    eventId: z.uuid(),
    type: eventTypeSchema,
    schemaVersion: z.number().int().positive(),
    occurredAt: z.iso.datetime({ offset: true }),
    entity: sourceEntitySchema,
    actor: sourceEntitySchema.optional(),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

export type ZentraEventEnvelope = z.infer<typeof zentraEventEnvelopeSchema>;

export const zentraCompanyCreatedEventSchema = z
  .object({
    eventId: z.uuid(),
    type: z.literal("product.company_created"),
    schemaVersion: z.literal(1),
    occurredAt: z.iso.datetime({ offset: true }),
    entity: z.object({ type: z.literal("company"), id: z.uuid() }).strict(),
    actor: z
      .object({ type: z.literal("user"), id: z.uuid() })
      .strict()
      .optional(),
    data: z
      .object({
        companyId: z.uuid(),
        createdByUserId: z.uuid(),
      })
      .strict(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.entity.id !== event.data.companyId) {
      context.addIssue({
        code: "custom",
        path: ["entity", "id"],
        message: "Company identity must match data.companyId",
      });
    }
    if (
      event.actor !== undefined &&
      event.actor.id !== event.data.createdByUserId
    ) {
      context.addIssue({
        code: "custom",
        path: ["actor", "id"],
        message: "Actor identity must match data.createdByUserId",
      });
    }
  });

export type ZentraCompanyCreatedEvent = z.infer<
  typeof zentraCompanyCreatedEventSchema
>;

export const parseZentraInboundEvent = (
  input: unknown,
): ZentraEventEnvelope => {
  const envelope = zentraEventEnvelopeSchema.safeParse(input);
  if (!envelope.success) {
    throw new ValidationError("Zentra event payload is invalid");
  }
  if (envelope.data.type !== "product.company_created") {
    return envelope.data;
  }
  const supported = zentraCompanyCreatedEventSchema.safeParse(input);
  if (!supported.success) {
    throw new ValidationError("Zentra event payload is invalid");
  }
  return supported.data;
};

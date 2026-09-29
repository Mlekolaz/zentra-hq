import { z } from "zod";

const configuredApiBase: unknown = import.meta.env["VITE_API_BASE_URL"];
const API_BASE =
  typeof configuredApiBase === "string"
    ? configuredApiBase
    : "http://localhost:4100";

const eventItemSchema = z.object({
  id: z.uuid(),
  rawEventId: z.uuid(),
  type: z.string(),
  source: z.string(),
  occurredAt: z.iso.datetime({ offset: true }),
  receivedAt: z.iso.datetime({ offset: true }),
  processingStatus: z.enum([
    "queued",
    "processing",
    "succeeded",
    "retryable_failed",
    "permanently_failed",
  ]),
  traceId: z.uuid(),
});
export type EventItem = z.infer<typeof eventItemSchema>;

const overviewSchema = z.object({
  totalEvents: z.number().int().nonnegative(),
  eventsToday: z.number().int().nonnegative(),
  failedProcessing: z.number().int().nonnegative(),
  pendingApprovals: z.number().int().nonnegative(),
  recentEvents: z.array(eventItemSchema),
});
export type Overview = z.infer<typeof overviewSchema>;

const integrationSchema = z.object({
  provider: z.string(),
  capabilities: z.array(z.string()),
  health: z.object({
    status: z.string(),
    checkedAt: z.iso.datetime({ offset: true }),
    message: z.string().optional(),
  }),
  developmentOnly: z.boolean(),
});
export type Integration = z.infer<typeof integrationSchema>;

const get = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`HQ API returned ${response.status}`);
  const body: unknown = await response.json();
  return schema.parse(body);
};

export const api = {
  overview: () => get("/v1/overview", overviewSchema),
  events: () =>
    get("/v1/events?limit=100", z.object({ events: z.array(eventItemSchema) })),
  integrations: () =>
    get(
      "/v1/integrations",
      z.object({ integrations: z.array(integrationSchema) }),
    ),
};

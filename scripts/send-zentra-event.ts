import {
  createZentraWebhookSignature,
  zentraCompanyCreatedEventSchema,
} from "../packages/connectors/src/index.js";

const defaultEventId = "10000000-0000-4000-8000-000000000010";
const companyId = "10000000-0000-4000-8000-000000000020";
const userId = "10000000-0000-4000-8000-000000000030";

const readEventId = (arguments_: readonly string[]): string => {
  if (arguments_.length === 0) return defaultEventId;
  if (arguments_.length !== 2 || arguments_[0] !== "--event-id") {
    throw new Error("Usage: pnpm demo:zentra-event -- --event-id <uuid>");
  }
  const eventId = arguments_[1];
  if (eventId === undefined) throw new Error("Missing --event-id value");
  return eventId;
};

const secret = process.env.ZENTRA_WEBHOOK_SECRET;
if (secret === undefined) {
  throw new Error("ZENTRA_WEBHOOK_SECRET is required");
}
const hqUrl = process.env.HQ_URL ?? "http://127.0.0.1:4100";
const event = zentraCompanyCreatedEventSchema.parse({
  eventId: readEventId(process.argv.slice(2)),
  type: "product.company_created",
  schemaVersion: 1,
  occurredAt: "2026-10-01T12:00:00.000Z",
  entity: { type: "company", id: companyId },
  actor: { type: "user", id: userId },
  data: { companyId, createdByUserId: userId },
});
const rawBody = Buffer.from(JSON.stringify(event), "utf8");
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createZentraWebhookSignature({
  secret,
  timestamp,
  rawBody,
});

const response = await fetch(new URL("/v1/webhooks/zentra", hqUrl), {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-zentra-timestamp": timestamp,
    "x-zentra-signature": signature,
  },
  body: rawBody,
});
const responseBody = await response.text();
console.log(`${response.status} ${response.statusText}`);
console.log(responseBody);
if (!response.ok) process.exitCode = 1;

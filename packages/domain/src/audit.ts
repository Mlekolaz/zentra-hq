import type { TraceId } from "./ids.js";

export type AuditActorType = "human" | "system" | "ai" | "connector";

export type AuditEntry = {
  id: string;
  actorType: AuditActorType;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Readonly<Record<string, unknown>>;
  traceId: TraceId;
  createdAt: string;
};

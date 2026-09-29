import { newId } from "@zentra/domain";
import type { AuditActorType, TraceId } from "@zentra/domain";
import type { PolicyDecision, PolicyEvaluator, PolicyLevel } from "./policy.js";

export type ActionRequestStatus =
  "drafted" | "suggested" | "awaiting_approval" | "ready" | "denied";

export type ActionRequest = {
  id: string;
  actionType: string;
  requestedBy: { type: AuditActorType; id: string | null };
  target: Readonly<Record<string, unknown>>;
  input: Readonly<Record<string, unknown>>;
  riskLevel: "low" | "medium" | "high" | "critical";
  requiredPolicyLevel: PolicyLevel;
  status: ActionRequestStatus;
  traceId: TraceId;
  createdAt: string;
};

export type ApprovalRequest = {
  id: string;
  actionRequestId: string;
  requestedAt: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
};

export interface ActionRequestStore {
  saveActionRequest(request: ActionRequest): Promise<void>;
  saveApprovalRequest(request: ApprovalRequest): Promise<void>;
  saveAuditRecord(record: ActionAuditRecord): Promise<void>;
}

export type ActionAuditRecord = {
  action:
    "action_request.created" | "approval.requested" | "policy.action_denied";
  targetType: "action_request" | "approval_request";
  targetId: string;
  actor: { type: AuditActorType; id: string | null };
  traceId: TraceId;
  metadata: Readonly<Record<string, unknown>>;
};

export type CreateActionInput = {
  actionType: string;
  actor: { type: AuditActorType; id: string | null };
  target: Readonly<Record<string, unknown>>;
  input: Readonly<Record<string, unknown>>;
  traceId: TraceId;
  requestedPolicyLevel?: PolicyLevel;
};

export type CreateActionResult = {
  actionRequest: ActionRequest;
  approvalRequest: ApprovalRequest | null;
  decision: PolicyDecision;
};

export class ActionRequestService {
  public constructor(
    private readonly policy: PolicyEvaluator,
    private readonly store: ActionRequestStore,
  ) {}

  public async create(input: CreateActionInput): Promise<CreateActionResult> {
    const decision = this.policy.evaluate({
      actor: input.actor,
      actionType: input.actionType,
      traceId: input.traceId,
      ...(input.requestedPolicyLevel === undefined
        ? {}
        : { requestedPolicyLevel: input.requestedPolicyLevel }),
    });
    const status: ActionRequestStatus = !decision.allowed
      ? "denied"
      : decision.approvalRequired
        ? "awaiting_approval"
        : decision.level === "DRAFT"
          ? "drafted"
          : decision.level === "SUGGEST"
            ? "suggested"
            : "ready";
    const riskLevel =
      decision.level === "FORBIDDEN"
        ? "critical"
        : decision.level === "EXECUTE_WITH_APPROVAL"
          ? "high"
          : "low";
    const actionRequest: ActionRequest = {
      id: newId(),
      actionType: input.actionType,
      requestedBy: input.actor,
      target: structuredClone(input.target),
      input: structuredClone(input.input),
      riskLevel,
      requiredPolicyLevel: decision.level,
      status,
      traceId: input.traceId,
      createdAt: new Date().toISOString(),
    };
    await this.store.saveActionRequest(actionRequest);
    await this.store.saveAuditRecord({
      action: "action_request.created",
      targetType: "action_request",
      targetId: actionRequest.id,
      actor: input.actor,
      traceId: input.traceId,
      metadata: { actionType: input.actionType, policyLevel: decision.level },
    });
    if (!decision.allowed) {
      await this.store.saveAuditRecord({
        action: "policy.action_denied",
        targetType: "action_request",
        targetId: actionRequest.id,
        actor: input.actor,
        traceId: input.traceId,
        metadata: { reasonCodes: decision.reasonCodes },
      });
    }

    const approvalRequest: ApprovalRequest | null = decision.approvalRequired
      ? {
          id: newId(),
          actionRequestId: actionRequest.id,
          requestedAt: new Date().toISOString(),
          status: "pending",
          decidedBy: null,
          decidedAt: null,
          decisionReason: null,
        }
      : null;
    if (approvalRequest !== null) {
      await this.store.saveApprovalRequest(approvalRequest);
      await this.store.saveAuditRecord({
        action: "approval.requested",
        targetType: "approval_request",
        targetId: approvalRequest.id,
        actor: input.actor,
        traceId: input.traceId,
        metadata: { actionRequestId: actionRequest.id },
      });
    }
    return { actionRequest, approvalRequest, decision };
  }
}

export class InMemoryActionRequestStore implements ActionRequestStore {
  public readonly actions: ActionRequest[] = [];
  public readonly approvals: ApprovalRequest[] = [];
  public readonly auditRecords: ActionAuditRecord[] = [];

  public async saveActionRequest(request: ActionRequest): Promise<void> {
    this.actions.push(structuredClone(request));
  }

  public async saveApprovalRequest(request: ApprovalRequest): Promise<void> {
    this.approvals.push(structuredClone(request));
  }

  public async saveAuditRecord(record: ActionAuditRecord): Promise<void> {
    this.auditRecords.push(structuredClone(record));
  }
}

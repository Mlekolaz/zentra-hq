import { newTraceId } from "@zentra/domain";
import { describe, expect, it } from "vitest";
import {
  ActionRequestService,
  InMemoryActionRequestStore,
} from "./action-request.js";
import { DeterministicPolicyEvaluator } from "./policy.js";

const evaluate = (actionType: string) =>
  new DeterministicPolicyEvaluator().evaluate({
    actor: { type: "human", id: "member-1" },
    actionType,
    traceId: newTraceId(),
  });

describe("DeterministicPolicyEvaluator", () => {
  it("allows READ without execution", () => {
    expect(evaluate("read_event")).toMatchObject({
      allowed: true,
      level: "READ",
      executionAllowed: false,
    });
  });

  it("allows DRAFT only as an unexecuted draft", () => {
    expect(evaluate("draft_message")).toMatchObject({
      allowed: true,
      level: "DRAFT",
      executionAllowed: false,
    });
  });

  it("creates an approval requirement for guarded execution", async () => {
    const store = new InMemoryActionRequestStore();
    const result = await new ActionRequestService(
      new DeterministicPolicyEvaluator(),
      store,
    ).create({
      actionType: "send_external_message",
      actor: { type: "ai", id: "future-ai" },
      target: { channel: "email" },
      input: { draftId: "draft-1" },
      traceId: newTraceId(),
    });
    expect(result.actionRequest.status).toBe("awaiting_approval");
    expect(result.approvalRequest?.status).toBe("pending");
    expect(store.approvals).toHaveLength(1);
    expect(store.auditRecords.map((record) => record.action)).toEqual([
      "action_request.created",
      "approval.requested",
    ]);
  });

  it.each(["production_deploy", "delete_customer", "issue_refund"])(
    "forbids %s",
    (actionType) => {
      expect(evaluate(actionType)).toMatchObject({
        allowed: false,
        level: "FORBIDDEN",
      });
    },
  );

  it("does not let an AI actor override the policy level", () => {
    const decision = new DeterministicPolicyEvaluator().evaluate({
      actor: { type: "ai", id: "future-ai" },
      actionType: "send_external_message",
      requestedPolicyLevel: "AUTO_EXECUTE",
      traceId: newTraceId(),
    });
    expect(decision).toMatchObject({
      level: "EXECUTE_WITH_APPROVAL",
      approvalRequired: true,
      executionAllowed: false,
    });
    expect(decision.reasonCodes).toContain("ACTOR_POLICY_OVERRIDE_IGNORED");
  });

  it("audits a policy-denied action request", async () => {
    const store = new InMemoryActionRequestStore();
    await new ActionRequestService(
      new DeterministicPolicyEvaluator(),
      store,
    ).create({
      actionType: "production_deploy",
      actor: { type: "system", id: "automation" },
      target: { environment: "production" },
      input: {},
      traceId: newTraceId(),
    });
    expect(store.auditRecords.map((record) => record.action)).toContain(
      "policy.action_denied",
    );
  });
});

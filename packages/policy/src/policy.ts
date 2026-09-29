import type { AuditActorType, TraceId } from "@zentra/domain";
import { z } from "zod";

export const policyLevelSchema = z.enum([
  "READ",
  "DRAFT",
  "SUGGEST",
  "EXECUTE_WITH_APPROVAL",
  "AUTO_EXECUTE",
  "FORBIDDEN",
]);
export type PolicyLevel = z.infer<typeof policyLevelSchema>;

export type ActionDefinition = {
  actionType: string;
  policyLevel: PolicyLevel;
  riskLevel: "low" | "medium" | "high" | "critical";
  description: string;
};

export type PolicyActor = {
  type: AuditActorType;
  id: string | null;
};

export type PolicyContext = {
  actor: PolicyActor;
  actionType: string;
  traceId: TraceId;
  requestedPolicyLevel?: PolicyLevel;
};

export type PolicyDecision = {
  allowed: boolean;
  level: PolicyLevel;
  approvalRequired: boolean;
  executionAllowed: boolean;
  reasonCodes: string[];
};

export interface PolicyEvaluator {
  evaluate(context: PolicyContext): PolicyDecision;
}

const actionDefinitions = [
  {
    actionType: "read_event",
    policyLevel: "READ",
    riskLevel: "low",
    description: "Read an HQ event",
  },
  {
    actionType: "draft_message",
    policyLevel: "DRAFT",
    riskLevel: "low",
    description: "Create an unexecuted draft",
  },
  {
    actionType: "suggest_pipeline_change",
    policyLevel: "SUGGEST",
    riskLevel: "low",
    description: "Recommend a pipeline change",
  },
  {
    actionType: "send_external_message",
    policyLevel: "EXECUTE_WITH_APPROVAL",
    riskLevel: "high",
    description: "Send a message outside HQ",
  },
  {
    actionType: "production_deploy",
    policyLevel: "FORBIDDEN",
    riskLevel: "critical",
    description: "Deploy production code",
  },
  {
    actionType: "delete_customer",
    policyLevel: "FORBIDDEN",
    riskLevel: "critical",
    description: "Delete a customer",
  },
  {
    actionType: "issue_refund",
    policyLevel: "FORBIDDEN",
    riskLevel: "critical",
    description: "Issue a financial refund",
  },
] satisfies readonly ActionDefinition[];

export const m0ActionDefinitions: ReadonlyMap<string, ActionDefinition> =
  new Map(
    actionDefinitions.map(
      (definition) => [definition.actionType, definition] as const,
    ),
  );

export class DeterministicPolicyEvaluator implements PolicyEvaluator {
  public constructor(private readonly definitions = m0ActionDefinitions) {}

  public evaluate(context: PolicyContext): PolicyDecision {
    const definition = this.definitions.get(context.actionType);
    if (definition === undefined) {
      return {
        allowed: false,
        level: "FORBIDDEN",
        approvalRequired: false,
        executionAllowed: false,
        reasonCodes: ["ACTION_NOT_DEFINED"],
      };
    }

    const reasonCodes = [`POLICY_${definition.policyLevel}`];
    if (
      (context.actor.type === "ai" || context.actor.type === "system") &&
      context.requestedPolicyLevel !== undefined &&
      context.requestedPolicyLevel !== definition.policyLevel
    ) {
      reasonCodes.push("ACTOR_POLICY_OVERRIDE_IGNORED");
    }

    switch (definition.policyLevel) {
      case "READ":
      case "DRAFT":
      case "SUGGEST":
        return {
          allowed: true,
          level: definition.policyLevel,
          approvalRequired: false,
          executionAllowed: false,
          reasonCodes,
        };
      case "EXECUTE_WITH_APPROVAL":
        return {
          allowed: true,
          level: definition.policyLevel,
          approvalRequired: true,
          executionAllowed: false,
          reasonCodes,
        };
      case "AUTO_EXECUTE":
        return {
          allowed: true,
          level: definition.policyLevel,
          approvalRequired: false,
          executionAllowed: true,
          reasonCodes,
        };
      case "FORBIDDEN":
        return {
          allowed: false,
          level: definition.policyLevel,
          approvalRequired: false,
          executionAllowed: false,
          reasonCodes,
        };
    }
  }
}

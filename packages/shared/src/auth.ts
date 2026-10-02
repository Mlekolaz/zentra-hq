import { AuthenticationError, ConfigurationError } from "@zentra/domain";
import type { MemberId } from "@zentra/domain";

export type RequestIdentity = {
  memberId: MemberId;
  displayName: string;
  mode: "development";
};

export interface IdentityProvider {
  resolve(): Promise<RequestIdentity>;
}

export class DevelopmentIdentityProvider implements IdentityProvider {
  public constructor(nodeEnvironment: string) {
    if (nodeEnvironment !== "development" && nodeEnvironment !== "test") {
      throw new ConfigurationError(
        "Development identity cannot run in production",
      );
    }
  }

  public async resolve(): Promise<RequestIdentity> {
    return {
      memberId: "00000000-0000-4000-8000-000000000001",
      displayName: "Development Operator",
      mode: "development",
    };
  }
}

// Receiver-only production has no interactive operator authentication yet.
// Never fabricate a member or treat webhook authentication as a user session.
export class ReceiverOnlyIdentityProvider implements IdentityProvider {
  public async resolve(): Promise<RequestIdentity> {
    throw new AuthenticationError("Operator authentication is not configured");
  }
}

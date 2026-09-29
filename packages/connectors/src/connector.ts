import type { RawEvent } from "@zentra/domain";
import type { CanonicalEvent } from "@zentra/events";

export const connectorCapabilities = [
  "WEBHOOKS",
  "POLLING",
  "READ_MESSAGES",
  "SEND_MESSAGES",
  "CREATE_DRAFT",
  "READ_COMMENTS",
  "WRITE_COMMENTS",
  "READ_ANALYTICS",
  "READ_MEETINGS",
  "WRITE_MEETINGS",
  "READ_BILLING",
  "READ_DEPLOYMENTS",
] as const;
export type ConnectorCapability = (typeof connectorCapabilities)[number];

export type ConnectorHealthStatus =
  | "CONNECTED"
  | "DEGRADED"
  | "RATE_LIMITED"
  | "AUTH_EXPIRED"
  | "DISCONNECTED"
  | "DISABLED";

export type ConnectorHealth = {
  status: ConnectorHealthStatus;
  checkedAt: string;
  message?: string;
};

export interface Connector {
  readonly provider: string;
  capabilities(): ReadonlySet<ConnectorCapability>;
  health(): Promise<ConnectorHealth>;
  normalize(rawEvent: RawEvent): Promise<CanonicalEvent[]>;
}

export class ConnectorRegistry {
  readonly #connectors: ReadonlyMap<string, Connector>;

  public constructor(connectors: readonly Connector[]) {
    this.#connectors = new Map(
      connectors.map((connector) => [connector.provider, connector]),
    );
  }

  public get(provider: string): Connector | undefined {
    return this.#connectors.get(provider);
  }

  public list(): readonly Connector[] {
    return [...this.#connectors.values()];
  }
}

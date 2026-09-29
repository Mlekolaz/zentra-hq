# Connector conventions

A connector translates provider facts into canonical facts and reports only capabilities it actually implements. Domain and policy code depend on the connector port, never Gmail, Unipile, Stripe, or another provider SDK.

## Responsibilities

- verify source-specific webhook signatures against exact raw bytes through a separate verifier;
- preserve external event, account, message, and object IDs;
- normalize into supported versioned schemas;
- derive stable canonical event IDs so replay writes the same facts, including when one raw batch produces multiple facts of the same type;
- declare capabilities rather than assuming symmetry across providers;
- report `CONNECTED`, `DEGRADED`, `RATE_LIMITED`, `AUTH_EXPIRED`, `DISCONNECTED`, or `DISABLED`;
- expose a kill switch/disabled state;
- support provider-specific cursor and polling interfaces only when applicable.

Future adapters should handle rate-limit feedback, bounded provider retries, token refresh, reconnect, and circuit-breaker behavior without hiding state. Token refresh and credentials stay server-side. Outbound actions are audited and pass policy/approval before a provider executor is invoked.

## Capability separation

The base normalizer does not require `sync()` or write methods. Polling, message writes, comments, analytics, meetings, billing, and deployments should use capability-specific interfaces. An Official LinkedIn adapter and an alternative LinkedIn adapter may implement the same capability contract, but neither may claim unsupported DM access.

## M0

Mock Connector supports `WEBHOOKS` and `READ_MESSAGES`, converts the documented mock payload to `communication.message_received`, and is clearly labeled development-only. No fake Gmail, Stripe, social, billing, or deployment connectors exist.

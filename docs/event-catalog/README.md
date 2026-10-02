# Event catalog conventions

Canonical event types use extensible lowercase strings:

```text
<domain>.<past_tense_fact>
```

An event is an immutable fact: `billing.payment_failed`. A command is an intent: `fail_payment` would be a poor event name. An action request is a governed proposal to do something, such as `send_external_message`; it is not evidence that the message was sent.

Every canonical event has a positive `schemaVersion`. A published version keeps its meaning. Breaking interpretation requires a new version and an explicit upcaster or consumer strategy; old rows are not silently rewritten.

## Implemented events

### `product.company_created` — schema version 1

Source: trusted Zentra semantic event channel.

Source data:

```json
{
  "companyId": "uuid",
  "createdByUserId": "uuid"
}
```

Canonical mapping preserves the type and source `eventId`, uses the company as subject, includes the optional source actor as a user, and retains only `companyId` and `createdByUserId` in the payload. The canonical deduplication key is `source-event:<eventId>`.

`communication.message_received` remains implemented by the development-only Mock Connector.

## Future examples

```text
product.user_registered
product.feature_used
product.error_occurred
communication.message_received
communication.message_sent
communication.comment_received
crm.person_created
crm.entity_merge_suggested
pipeline.card_created
pipeline.stage_changed
task.created
task.completed
meeting.detected
billing.subscription_created
billing.payment_failed
social.content_published
social.metrics_updated
dev.commit_pushed
dev.deployment_failed
security.login_failed
security.anomaly_detected
ai.classification_completed
ai.action_recommended
action.approval_requested
action.executed
```

Catalog inclusion under future examples does not imply connector or product support.

Payloads contain event-specific data. Shared routing and trace fields stay in the canonical envelope. Preserve provider IDs whenever they exist, keep `occurredAt` distinct from `receivedAt`, and never place mutable CRM or task state inside the meaning of a historical event.

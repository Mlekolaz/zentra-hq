# Event catalog conventions

Canonical event types use extensible lowercase strings:

```text
<domain>.<past_tense_fact>
```

An event is an immutable fact: `billing.payment_failed`. A command is an intent: `fail_payment` would be a poor event name. An action request is a governed proposal to do something, such as `send_external_message`; it is not evidence that the message was sent.

Every canonical event has a positive `schemaVersion`. A published version keeps its meaning. Breaking interpretation requires a new version and an explicit upcaster or consumer strategy; old rows are not silently rewritten.

## Future examples

```text
product.user_registered
product.company_created
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

M0 implements only `communication.message_received` from Mock Connector. Catalog inclusion does not imply connector or product support.

Payloads contain event-specific data. Shared routing and trace fields stay in the canonical envelope. Preserve provider IDs whenever they exist, keep `occurredAt` distinct from `receivedAt`, and never place mutable CRM or task state inside the meaning of a historical event.

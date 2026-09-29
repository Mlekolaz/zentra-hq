# Traceability

M0 links ingress, raw storage, queue delivery, processing runs, canonical events, dead letters, and audit entries with `traceId`, plus raw and canonical identifiers where relevant. Logs include identifiers and stable error codes but exclude provider payloads and credentials.

A future AI decision record should contain:

- immutable input and evidence references;
- provider and model name;
- model version when available;
- prompt/template version;
- confidence and machine-readable reason codes;
- structured output and timestamp;
- trace ID and the resulting action-request ID, if any.

The record explains a recommendation; it does not authorize it. M0 intentionally does not add an `ai_decisions` table before an actual AI flow exists.

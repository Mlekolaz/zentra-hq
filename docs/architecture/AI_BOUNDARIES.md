# AI boundaries

AI is not enabled in M0.

Future AI may classify facts, summarize context, extract candidate tasks, draft replies, recommend pipeline changes, group similar reports, and explain why an item may deserve attention.

AI is never the authority for authentication, authorization, access control, financial operations, destructive operations, production deployment, secret handling, or permission escalation. AI output may become an `ActionRequest`; deterministic policy decides whether it is allowed, draft-only, approval-gated, automatic under an explicit future policy, or forbidden. Approval and execution remain separate steps.

No model SDK, prompt runtime, embeddings, vector search, agent orchestration, or memory is present in M0.

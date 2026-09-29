# Zentra HQ product vision

> This is the target vision. It does not define the scope of the current milestone.

Zentra HQ is the operating system for Moja Zentra: a place where many noisy source events become a small, explainable queue of work that deserves attention. A useful morning view says what changed, what needs a decision, what was safely ignored, and why.

## Attention management

Overview prioritizes actionable conditions rather than maximizing charts. The future Attention Engine combines urgency, business value, risk, SLA exposure, customer impact, response need, relationship value, novelty, and confidence. Each reason remains inspectable.

## Communications and relationships

Unified Inbox will join supported email, messaging, and social channels without pretending every provider has equal capabilities. Automatic CRM will create people and companies from observed interactions. A single person may have multiple deterministic identities; uncertain merges remain suggestions. Timeline will show chronological relationship facts across sources.

Follow-up Engine will track who owes the next response and when. Meetings will add calendar detection, briefing, notes, and eventually transcript-derived facts. AI Task Engine may extract candidate work and deduplicate several reports into one task or incident with multiple evidence links.

## Configurable work

Pipelines are stored as data, not compiled as one sales funnel. Teams may define processes such as LinkedIn Outreach, Accounting Offices, Testers, Partnerships, Social Leads, and Sales. The system will connect event facts to pipeline transitions without rewriting history.

Tester management will link feedback, product context, related reports, follow-up status, and customer impact. Task views will unite work detected from messages, meetings, product errors, billing, security, development, and explicit team actions.

## Customer and product intelligence

Customer Health will combine transparent product, support, billing, and relationship signals. Product Analytics will begin with first-party semantic events and may later incorporate GA4 and Clarity. Universal Search will answer evidence-backed questions across people, companies, events, tasks, and timelines.

## Growth and operations

Marketing will connect campaigns and content to qualified activity and paid outcomes. Social Intelligence will compare content against account-specific baselines, analyze supported comments and leads, and respect provider capability differences. Billing will integrate supported Stripe and Paynow facts. DevOps will accept semantic GitHub, Railway, Supabase, and Sentry events. Security will surface logins, anomalies, auth failures, admin operations, and other high-risk facts.

Daily Briefing will summarize what changed, what requires action, and what was filtered as routine. It must preserve evidence and never hide uncertainty.

## Event model and connector strategy

Every source enters a common event-driven core. Raw facts are immutable, canonical facts are versioned, and current-state projections are separate. Connectors expose explicit capabilities, health, verification, sync cursor behavior, rate limits, reconnect, circuit-breaker state, and kill switches. Official and alternative providers can implement the same port without leaking into domain behavior.

## Governed actions and AI

AI may classify, summarize, extract, draft, recommend, and explain. It cannot grant permissions. External or risky work becomes an ActionRequest, deterministic policy assigns a level, and required approval precedes any executor. Authentication, payments, destructive work, deployments, and access control never rely on model judgment.

Every automated decision should cite inputs/evidence, model and prompt versions when relevant, confidence, reason codes, output, timestamp, and trace ID.

## HQ security

HQ uses its own database and server-side credentials. The browser is untrusted and never receives a service role. Production Zentra sends signed semantic events through an outbox/dispatcher boundary rather than sharing unrestricted database access. Logs and audit records exclude secrets. Development bypasses cannot start in production.

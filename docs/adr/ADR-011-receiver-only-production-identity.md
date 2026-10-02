# ADR-011: Receiver-only production identity

## Status

Accepted — 2026-10-03

## Context

M1A.3B prepares the signed Zentra receiver for production provisioning without deploying it. HQ has an identity port but no production operator authentication implementation. Constructing the development identity aborts production startup; removing that guard or inventing a production member would expose operational data.

## Decision

Production uses a receiver-only identity provider which always rejects operator authentication with a stable authentication error. All operator read endpoints require the identity port before reading data. Development identity remains restricted to development/test. The public surface is storage health and the Zentra webhook, whose existing exact-byte, timestamped HMAC verifier authenticates the producer, not an operator. No webhook actor, browser header, or claimed role grants operator access.

Production requires Postgres, provider verification with a minimum 32-character secret, and a separate worker process. Production entrypoints do not load development `.env` files. API binding uses validated HOST/PORT, defaulting HOST to `0.0.0.0` in production and loopback locally.

## Alternatives considered

Disabling development security guards, generating a fixed production identity, using a webhook secret as operator authentication, and exposing read APIs anonymously were rejected.

## Consequences

The receiver and standalone worker can run independently of future user authentication without bypassing security. Production operator UI/read APIs remain unavailable (401) until a real, request-aware identity and authorization implementation replaces this fail-closed policy. This adds a narrower production boundary; accepted event-store, connector, and database decisions remain unchanged.

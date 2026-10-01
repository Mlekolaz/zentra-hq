import type {
  AuditEntry,
  DeadLetter,
  ProcessingRun,
  RawEvent,
} from "@zentra/domain";
import {
  ConsistencyError,
  rawEventSchema,
  ValidationError,
} from "@zentra/domain";
import type { CanonicalEvent } from "@zentra/events";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type {
  EventListItem,
  AtomicIngestionResult,
  EventIngestionPort,
  EventRepository,
  NewProcessingRun,
  NewRawEvent,
  OverviewSnapshot,
  ProcessingFailure,
  RawEventInsertResult,
  ReconcileOptions,
} from "./repository.js";

const dateValueSchema = z
  .union([z.date(), z.string()])
  .transform((value) =>
    value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
  );

const rawEventRowSchema = z.object({
  id: z.string(),
  source: z.string(),
  source_account_id: z.string().nullable(),
  event_type_hint: z.string().nullable(),
  external_event_id: z.string().nullable(),
  idempotency_key: z.string().nullable(),
  payload: z.unknown(),
  sanitized_headers: z.unknown(),
  occurred_at: z.union([dateValueSchema, z.null()]),
  received_at: dateValueSchema,
  trace_id: z.string(),
  created_at: dateValueSchema,
});

const parseRawEventRow = (row: unknown): RawEvent => {
  const parsed = rawEventRowSchema.parse(row);
  return rawEventSchema.parse({
    id: parsed.id,
    source: parsed.source,
    sourceAccountId: parsed.source_account_id,
    eventTypeHint: parsed.event_type_hint,
    externalEventId: parsed.external_event_id,
    idempotencyKey: parsed.idempotency_key,
    payload: parsed.payload,
    sanitizedHeaders: parsed.sanitized_headers,
    occurredAt: parsed.occurred_at,
    receivedAt: parsed.received_at,
    traceId: parsed.trace_id,
    createdAt: parsed.created_at,
  });
};

const processingRunRowSchema = z.object({
  id: z.string(),
  raw_event_id: z.string(),
  processor_name: z.string(),
  processor_version: z.string(),
  attempt: z.number(),
  status: z.enum([
    "queued",
    "processing",
    "succeeded",
    "retryable_failed",
    "permanently_failed",
  ]),
  started_at: dateValueSchema,
  completed_at: z.union([dateValueSchema, z.null()]),
  error_code: z.string().nullable(),
  sanitized_error_message: z.string().nullable(),
  trace_id: z.string(),
});

const parseProcessingRun = (row: unknown): ProcessingRun => {
  const value = processingRunRowSchema.parse(row);
  return {
    id: value.id,
    rawEventId: value.raw_event_id,
    processorName: value.processor_name,
    processorVersion: value.processor_version,
    attempt: value.attempt,
    status: value.status,
    startedAt: value.started_at,
    completedAt: value.completed_at,
    errorCode: value.error_code,
    sanitizedErrorMessage: value.sanitized_error_message,
    traceId: value.trace_id,
  };
};

type UnknownRow = Record<string, unknown>;
const firstRow = (rows: readonly UnknownRow[]): unknown => rows[0];

type Queryable = Pool | PoolClient;

export class PostgresEventRepository
  implements EventRepository, EventIngestionPort
{
  public constructor(private readonly pool: Pool) {}

  public async insertRawEvent(
    input: NewRawEvent,
  ): Promise<RawEventInsertResult> {
    return this.#insertRawEvent(this.pool, input);
  }

  async #insertRawEvent(
    database: Queryable,
    input: NewRawEvent,
  ): Promise<RawEventInsertResult> {
    const inserted = await database.query<UnknownRow>(
      `INSERT INTO raw_events (
        source, source_account_id, event_type_hint, external_event_id, idempotency_key,
        payload, sanitized_headers, occurred_at, received_at, trace_id
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)
      ON CONFLICT DO NOTHING RETURNING *`,
      [
        input.source,
        input.sourceAccountId,
        input.eventTypeHint,
        input.externalEventId,
        input.idempotencyKey,
        JSON.stringify(input.payload),
        JSON.stringify(input.sanitizedHeaders),
        input.occurredAt,
        input.receivedAt,
        input.traceId,
      ],
    );
    if (inserted.rowCount === 1) {
      return {
        rawEvent: parseRawEventRow(firstRow(inserted.rows)),
        created: true,
        duplicateReason: null,
      };
    }

    const existing = await database.query<UnknownRow>(
      `SELECT *,
         COALESCE(
           $3::text IS NOT NULL AND idempotency_key = $3::text,
           false
         ) AS explicit_match,
         COALESCE(
           $4::text IS NOT NULL AND external_event_id = $4::text,
           false
         ) AS provider_match
       FROM raw_events
       WHERE source = $1::text
         AND COALESCE(source_account_id, '') = COALESCE($2::text, '')
         AND (
           COALESCE(
             $3::text IS NOT NULL AND idempotency_key = $3::text,
             false
           )
           OR COALESCE(
             $4::text IS NOT NULL AND external_event_id = $4::text,
             false
           )
       )
       ORDER BY created_at ASC`,
      [
        input.source,
        input.sourceAccountId,
        input.idempotencyKey,
        input.externalEventId,
      ],
    );
    const matchSchema = z.object({
      explicit_match: z.boolean(),
      provider_match: z.boolean(),
    });
    const matches = existing.rows.map((row) => ({
      rawEvent: parseRawEventRow(row),
      ...matchSchema.parse(row),
    }));
    const explicitMatch = matches.find(
      (match) => match.explicit_match,
    )?.rawEvent;
    const providerMatch = matches.find(
      (match) => match.provider_match,
    )?.rawEvent;
    if (
      explicitMatch !== undefined &&
      providerMatch !== undefined &&
      explicitMatch.id !== providerMatch.id
    ) {
      throw new ValidationError(
        "Idempotency identifiers refer to different raw events",
      );
    }
    const rawEvent = explicitMatch ?? providerMatch;
    if (rawEvent === undefined) {
      throw new ConsistencyError(
        "CONFLICT_RESOLUTION_FAILED",
        "Conflicting event could not be resolved safely",
      );
    }
    return {
      rawEvent,
      created: false,
      duplicateReason:
        explicitMatch !== undefined ? "idempotency_key" : "provider_identity",
    };
  }

  public async ingestEventAtomically(
    input: NewRawEvent,
  ): Promise<AtomicIngestionResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await this.#insertRawEvent(client, input);
      let queueDisposition: AtomicIngestionResult["queueDisposition"];
      if (inserted.created) {
        await client.query(
          `INSERT INTO event_queue (raw_event_id, payload, available_at)
           VALUES ($1, $2::jsonb, now())`,
          [
            inserted.rawEvent.id,
            JSON.stringify({
              rawEventId: inserted.rawEvent.id,
              traceId: inserted.rawEvent.traceId,
            }),
          ],
        );
        queueDisposition = "enqueued";
      } else {
        const state = await client.query<UnknownRow>(
          `SELECT
             EXISTS (SELECT 1 FROM events WHERE raw_event_id = $1) AS has_canonical,
             EXISTS (
               SELECT 1 FROM processing_runs
               WHERE raw_event_id = $1 AND status = 'succeeded'
             ) AS has_success,
             EXISTS (SELECT 1 FROM dead_letters WHERE raw_event_id = $1) AS has_dead_letter,
             EXISTS (SELECT 1 FROM event_queue WHERE raw_event_id = $1) AS has_queue_item`,
          [inserted.rawEvent.id],
        );
        const parsedState = z
          .object({
            has_canonical: z.boolean(),
            has_success: z.boolean(),
            has_dead_letter: z.boolean(),
            has_queue_item: z.boolean(),
          })
          .parse(firstRow(state.rows));
        if (parsedState.has_canonical || parsedState.has_success) {
          queueDisposition = "already_processed";
        } else if (parsedState.has_dead_letter) {
          queueDisposition = "permanently_failed";
        } else if (parsedState.has_queue_item) {
          queueDisposition = "already_queued";
        } else {
          const recovered = await client.query(
            `INSERT INTO event_queue (raw_event_id, payload, available_at)
             VALUES ($1, $2::jsonb, now())
             ON CONFLICT (raw_event_id) DO NOTHING`,
            [
              inserted.rawEvent.id,
              JSON.stringify({
                rawEventId: inserted.rawEvent.id,
                traceId: inserted.rawEvent.traceId,
              }),
            ],
          );
          queueDisposition =
            recovered.rowCount === 1 ? "recovered" : "already_queued";
        }
      }

      await client.query(
        `INSERT INTO audit_entries (
           actor_type, actor_id, action, target_type, target_id, metadata, trace_id
         ) VALUES ('connector', $1, $2, 'raw_event', $3, $4::jsonb, $5)`,
        [
          input.source,
          inserted.created
            ? "ingestion.accepted"
            : "ingestion.duplicate_detected",
          inserted.rawEvent.id,
          JSON.stringify({
            source: input.source,
            duplicateReason: inserted.duplicateReason,
            queueDisposition,
          }),
          input.traceId,
        ],
      );
      await client.query("COMMIT");
      return { ...inserted, queueDisposition };
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async reconcileUndispatchedRawEvents(
    options: ReconcileOptions,
  ): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const recovered = await client.query<UnknownRow>(
        `WITH candidates AS (
           SELECT r.id, r.trace_id
           FROM raw_events r
           WHERE r.created_at < now() - ($1::text || ' milliseconds')::interval
             AND NOT EXISTS (SELECT 1 FROM events e WHERE e.raw_event_id = r.id)
             AND NOT EXISTS (
               SELECT 1 FROM processing_runs pr
               WHERE pr.raw_event_id = r.id AND pr.status = 'succeeded'
             )
             AND NOT EXISTS (SELECT 1 FROM dead_letters d WHERE d.raw_event_id = r.id)
             AND NOT EXISTS (SELECT 1 FROM event_queue q WHERE q.raw_event_id = r.id)
           ORDER BY r.created_at ASC
           FOR UPDATE OF r SKIP LOCKED
           LIMIT $2
         ), inserted AS (
           INSERT INTO event_queue (raw_event_id, payload, available_at)
           SELECT id, jsonb_build_object('rawEventId', id, 'traceId', trace_id), now()
           FROM candidates
           ON CONFLICT (raw_event_id) DO NOTHING
           RETURNING raw_event_id
         )
         SELECT i.raw_event_id, r.trace_id
         FROM inserted i
         JOIN raw_events r ON r.id = i.raw_event_id`,
        [
          Math.max(0, options.olderThanMs),
          Math.min(Math.max(options.limit, 1), 1000),
        ],
      );
      for (const candidate of recovered.rows) {
        const row = z
          .object({ raw_event_id: z.string(), trace_id: z.string() })
          .parse(candidate);
        await client.query(
          `INSERT INTO audit_entries (
             actor_type, actor_id, action, target_type, target_id, metadata, trace_id
           ) VALUES ('system', 'raw-event-reconciler', 'ingestion.queue_recovered',
             'raw_event', $1, '{}'::jsonb, $2)`,
          [row.raw_event_id, row.trace_id],
        );
      }
      await client.query("COMMIT");
      return recovered.rowCount ?? 0;
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async findRawEvent(id: string): Promise<RawEvent | null> {
    const result = await this.pool.query<UnknownRow>(
      "SELECT * FROM raw_events WHERE id = $1",
      [id],
    );
    return result.rowCount === 0
      ? null
      : parseRawEventRow(firstRow(result.rows));
  }

  public async saveCanonicalEvent(
    event: CanonicalEvent,
  ): Promise<{ created: boolean }> {
    const result = await this.pool.query<UnknownRow>(
      `INSERT INTO events (
        id, raw_event_id, deduplication_key, type, schema_version, source, source_account_id, external_event_id,
        occurred_at, received_at, actor, subject, entity_refs, payload, metadata,
        correlation_id, causation_id, trace_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17,$18)
      ON CONFLICT DO NOTHING RETURNING id`,
      [
        event.id,
        event.rawEventId,
        event.deduplicationKey,
        event.type,
        event.schemaVersion,
        event.source,
        event.sourceAccountId,
        event.externalEventId,
        event.occurredAt,
        event.receivedAt,
        JSON.stringify(event.actor),
        JSON.stringify(event.subject),
        JSON.stringify(event.entityRefs),
        JSON.stringify(event.payload),
        JSON.stringify(event.metadata),
        event.correlationId,
        event.causationId,
        event.metadata.traceId,
      ],
    );
    return { created: result.rowCount === 1 };
  }

  public async startProcessingRun(
    input: NewProcessingRun,
  ): Promise<ProcessingRun> {
    const result = await this.pool.query<UnknownRow>(
      `INSERT INTO processing_runs (
        raw_event_id, processor_name, processor_version, attempt, status, trace_id
      ) VALUES ($1,$2,$3,$4,'processing',$5) RETURNING *`,
      [
        input.rawEventId,
        input.processorName,
        input.processorVersion,
        input.attempt,
        input.traceId,
      ],
    );
    return parseProcessingRun(firstRow(result.rows));
  }

  public async markProcessingSucceeded(
    runId: string,
    completedAt: string,
  ): Promise<void> {
    await this.pool.query(
      "UPDATE processing_runs SET status = 'succeeded', completed_at = $2 WHERE id = $1",
      [runId, completedAt],
    );
  }

  public async markProcessingFailed(
    runId: string,
    failure: ProcessingFailure,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE processing_runs
       SET status = $2, completed_at = $3, error_code = $4, sanitized_error_message = $5
       WHERE id = $1`,
      [
        runId,
        failure.status,
        failure.completedAt,
        failure.errorCode,
        failure.sanitizedErrorMessage,
      ],
    );
  }

  public async addDeadLetter(
    input: Omit<DeadLetter, "id" | "createdAt">,
  ): Promise<DeadLetter> {
    const result = await this.pool.query<UnknownRow>(
      `INSERT INTO dead_letters (raw_event_id, processor_name, reason, attempt_count, trace_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [
        input.rawEventId,
        input.processorName,
        input.reason,
        input.attemptCount,
        input.traceId,
      ],
    );
    const row = z
      .object({ id: z.string(), created_at: dateValueSchema })
      .parse(firstRow(result.rows));
    return { ...input, id: row.id, createdAt: row.created_at };
  }

  public async addAuditEntry(
    input: Omit<AuditEntry, "id" | "createdAt">,
  ): Promise<AuditEntry> {
    const result = await this.pool.query<UnknownRow>(
      `INSERT INTO audit_entries (actor_type, actor_id, action, target_type, target_id, metadata, trace_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING id, created_at`,
      [
        input.actorType,
        input.actorId,
        input.action,
        input.targetType,
        input.targetId,
        JSON.stringify(input.metadata),
        input.traceId,
      ],
    );
    const row = z
      .object({ id: z.string(), created_at: dateValueSchema })
      .parse(firstRow(result.rows));
    return { ...input, id: row.id, createdAt: row.created_at };
  }

  public async listEvents(limit: number): Promise<EventListItem[]> {
    const result = await this.pool.query<UnknownRow>(
      `SELECT e.id, e.raw_event_id, e.type, e.source, e.occurred_at, e.received_at, e.trace_id,
        COALESCE(run.status, 'queued') AS processing_status
       FROM events e
       LEFT JOIN LATERAL (
         SELECT status FROM processing_runs pr WHERE pr.raw_event_id = e.raw_event_id
         ORDER BY pr.attempt DESC, pr.started_at DESC LIMIT 1
       ) run ON true
       ORDER BY e.received_at DESC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 200)],
    );
    const rowSchema = z.object({
      id: z.string(),
      raw_event_id: z.string(),
      type: z.string(),
      source: z.string(),
      occurred_at: dateValueSchema,
      received_at: dateValueSchema,
      processing_status: processingRunRowSchema.shape.status,
      trace_id: z.string(),
    });
    return result.rows.map((candidate) => {
      const row = rowSchema.parse(candidate);
      return {
        id: row.id,
        rawEventId: row.raw_event_id,
        type: row.type,
        source: row.source,
        occurredAt: row.occurred_at,
        receivedAt: row.received_at,
        processingStatus: row.processing_status,
        traceId: row.trace_id,
      };
    });
  }

  public async getOverview(): Promise<OverviewSnapshot> {
    const [countsResult, recentEvents] = await Promise.all([
      this.pool.query<UnknownRow>(`SELECT
        (SELECT count(*)::int FROM events) AS total_events,
        (SELECT count(*)::int FROM events WHERE received_at >= date_trunc('day', now())) AS events_today,
        (SELECT count(*)::int FROM processing_runs WHERE status IN ('retryable_failed','permanently_failed')) AS failed_processing,
        (SELECT count(*)::int FROM approval_requests WHERE status = 'pending') AS pending_approvals`),
      this.listEvents(10),
    ]);
    const counts = z
      .object({
        total_events: z.number(),
        events_today: z.number(),
        failed_processing: z.number(),
        pending_approvals: z.number(),
      })
      .parse(firstRow(countsResult.rows));
    return {
      totalEvents: counts.total_events,
      eventsToday: counts.events_today,
      failedProcessing: counts.failed_processing,
      pendingApprovals: counts.pending_approvals,
      recentEvents,
    };
  }

  public async healthCheck(): Promise<boolean> {
    await this.pool.query("SELECT 1");
    return true;
  }
}

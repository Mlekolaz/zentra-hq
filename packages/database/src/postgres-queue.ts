import type {
  QueueDelivery,
  QueueLease,
  QueueMutationResult,
  RawEventQueueMessage,
  RawEventQueuePort,
} from "@zentra/events";
import type { Pool } from "pg";
import { z } from "zod";

const queueMessageSchema = z.object({
  rawEventId: z.uuid(),
  traceId: z.uuid(),
});

const queueRowSchema = z.object({
  id: z.string(),
  payload: z.unknown(),
  delivery_count: z.number().int().nonnegative(),
  lease_token: z.string(),
});

const queueCandidateSchema = z.object({
  id: z.string(),
  raw_event_id: z.string(),
  payload: z.unknown(),
  delivery_count: z.number().int().nonnegative(),
});

export type PostgresQueueOptions = {
  leaseTimeoutMs: number;
  maxDeliveries: number;
  processorName: string;
};

export class PostgresQueue implements RawEventQueuePort {
  public constructor(
    private readonly pool: Pool,
    private readonly options: PostgresQueueOptions,
  ) {}

  public async enqueue(
    message: RawEventQueueMessage,
    delayMs = 0,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO event_queue (raw_event_id, payload, available_at)
       VALUES ($1, $2::jsonb, now() + make_interval(secs => $3::double precision / 1000))
       ON CONFLICT (raw_event_id) DO NOTHING`,
      [message.rawEventId, JSON.stringify(message), Math.max(delayMs, 0)],
    );
  }

  public async receive(): Promise<QueueDelivery<RawEventQueueMessage> | null> {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const candidateResult = await client.query(
        `SELECT id, raw_event_id, payload, delivery_count
         FROM event_queue
         WHERE available_at <= now()
           AND (
             lease_token IS NULL
             OR locked_at < now() - make_interval(secs => $1::double precision / 1000)
           )
         ORDER BY available_at ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [Math.max(this.options.leaseTimeoutMs, 1)],
      );
      if (candidateResult.rowCount === 0) {
        await client.query("COMMIT");
        transactionOpen = false;
        return null;
      }

      const candidate = queueCandidateSchema.parse(candidateResult.rows[0]);
      if (candidate.delivery_count >= this.options.maxDeliveries) {
        const message = queueMessageSchema.parse(candidate.payload);
        await client.query(
          `INSERT INTO dead_letters (
             raw_event_id, processor_name, reason, attempt_count, trace_id
           ) VALUES (
             $1::uuid, $2::text, 'QUEUE_MAX_DELIVERIES_EXCEEDED',
             $3::integer, $4::uuid
           )`,
          [
            candidate.raw_event_id,
            this.options.processorName,
            candidate.delivery_count,
            message.traceId,
          ],
        );
        await client.query(
          `INSERT INTO audit_entries (
             actor_type, actor_id, action, target_type, target_id, metadata, trace_id
           ) VALUES (
             'system', $1::text, 'processing.poison_queue_item',
             'raw_event', $2::text,
             jsonb_build_object(
               'reason', 'QUEUE_MAX_DELIVERIES_EXCEEDED',
               'deliveryCount', $3::integer
             ), $4::uuid
           )`,
          [
            this.options.processorName,
            candidate.raw_event_id,
            candidate.delivery_count,
            message.traceId,
          ],
        );
        await client.query("DELETE FROM event_queue WHERE id = $1", [
          candidate.id,
        ]);
        await client.query("COMMIT");
        transactionOpen = false;
        return null;
      }

      const leased = await client.query(
        `UPDATE event_queue
         SET locked_at = now(), lease_token = gen_random_uuid(),
             delivery_count = delivery_count + 1
         WHERE id = $1
         RETURNING id, payload, delivery_count, lease_token`,
        [candidate.id],
      );
      const row = queueRowSchema.parse(leased.rows[0]);
      await client.query("COMMIT");
      transactionOpen = false;
      return {
        queueItemId: row.id,
        leaseToken: row.lease_token,
        deliveryCount: row.delivery_count,
        message: queueMessageSchema.parse(row.payload),
      };
    } catch (error: unknown) {
      if (transactionOpen) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async ack(lease: QueueLease): Promise<QueueMutationResult> {
    const result = await this.pool.query(
      "DELETE FROM event_queue WHERE id = $1 AND lease_token = $2",
      [lease.queueItemId, lease.leaseToken],
    );
    return result.rowCount === 1 ? "applied" : "stale";
  }

  public async retry(
    lease: QueueLease,
    message: RawEventQueueMessage,
    delayMs: number,
  ): Promise<QueueMutationResult> {
    const result = await this.pool.query(
      `UPDATE event_queue
       SET payload = $3::jsonb, locked_at = NULL, lease_token = NULL,
           available_at = now() + make_interval(secs => $4::double precision / 1000)
       WHERE id = $1 AND lease_token = $2`,
      [
        lease.queueItemId,
        lease.leaseToken,
        JSON.stringify(message),
        Math.max(delayMs, 0),
      ],
    );
    return result.rowCount === 1 ? "applied" : "stale";
  }

  public async hasActive(rawEventId: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT EXISTS (SELECT 1 FROM event_queue WHERE raw_event_id = $1) AS active",
      [rawEventId],
    );
    return z.object({ active: z.boolean() }).parse(result.rows[0]).active;
  }

  public async depth(): Promise<number> {
    const result = await this.pool.query(
      "SELECT count(*)::int AS count FROM event_queue",
    );
    return z.object({ count: z.number() }).parse(result.rows[0]).count;
  }
}

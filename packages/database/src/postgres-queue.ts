import type { QueueDelivery, QueuePort } from "@zentra/events";
import type { Pool } from "pg";
import { z } from "zod";

const queueRowSchema = z.object({
  id: z.string(),
  payload: z.unknown(),
});

export class PostgresQueue<T> implements QueuePort<T> {
  public constructor(
    private readonly pool: Pool,
    private readonly parseMessage: (input: unknown) => T,
  ) {}

  public async enqueue(message: T, delayMs = 0): Promise<void> {
    await this.pool.query(
      `INSERT INTO event_queue (payload, available_at)
       VALUES ($1::jsonb, now() + ($2::text || ' milliseconds')::interval)`,
      [JSON.stringify(message), Math.max(delayMs, 0)],
    );
  }

  public async receive(): Promise<QueueDelivery<T> | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `WITH candidate AS (
          SELECT id FROM event_queue
          WHERE available_at <= now()
            AND (locked_at IS NULL OR locked_at < now() - interval '5 minutes')
          ORDER BY available_at ASC
          FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE event_queue q SET locked_at = now()
        FROM candidate WHERE q.id = candidate.id
        RETURNING q.id, q.payload`,
      );
      await client.query("COMMIT");
      if (result.rowCount === 0) return null;
      const row = queueRowSchema.parse(result.rows[0]);
      return { deliveryId: row.id, message: this.parseMessage(row.payload) };
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async ack(deliveryId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM event_queue WHERE id = $1 AND locked_at IS NOT NULL",
      [deliveryId],
    );
  }

  public async retry(
    deliveryId: string,
    message: T,
    delayMs: number,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE event_queue SET payload = $2::jsonb, locked_at = NULL,
        available_at = now() + ($3::text || ' milliseconds')::interval
       WHERE id = $1 AND locked_at IS NOT NULL`,
      [deliveryId, JSON.stringify(message), Math.max(delayMs, 0)],
    );
  }

  public async depth(): Promise<number> {
    const result = await this.pool.query(
      "SELECT count(*)::int AS count FROM event_queue",
    );
    return z.object({ count: z.number() }).parse(result.rows[0]).count;
  }
}

import { newId } from "@zentra/domain";
import type { RawEventId, TraceId } from "@zentra/domain";

export type RawEventQueueMessage = {
  rawEventId: RawEventId;
  traceId: TraceId;
};

export type QueueDelivery<T> = {
  queueItemId: string;
  leaseToken: string;
  deliveryCount: number;
  message: T;
};

export type QueueLease = {
  queueItemId: string;
  leaseToken: string;
};

export type QueueMutationResult = "applied" | "stale";

export interface QueuePort<T> {
  enqueue(message: T, delayMs?: number): Promise<void>;
  receive(): Promise<QueueDelivery<T> | null>;
  ack(lease: QueueLease): Promise<QueueMutationResult>;
  retry(
    lease: QueueLease,
    message: T,
    delayMs: number,
  ): Promise<QueueMutationResult>;
  depth(): Promise<number>;
}

export interface RawEventQueuePort extends QueuePort<RawEventQueueMessage> {
  hasActive(rawEventId: RawEventId): Promise<boolean>;
}

export interface QueueClock {
  now(): number;
}

type QueueItem<T> = {
  queueItemId: string;
  message: T;
  availableAt: number;
  lockedAt: number | null;
  leaseToken: string | null;
  deliveryCount: number;
};

export class InMemoryQueue<T> implements QueuePort<T> {
  readonly #clock: QueueClock;
  readonly #items: QueueItem<T>[] = [];

  public constructor(clock: QueueClock = { now: () => Date.now() }) {
    this.#clock = clock;
  }

  public async enqueue(message: T, delayMs = 0): Promise<void> {
    this.#items.push({
      queueItemId: newId(),
      message: structuredClone(message),
      availableAt: this.#clock.now() + Math.max(0, delayMs),
      lockedAt: null,
      leaseToken: null,
      deliveryCount: 0,
    });
  }

  public async receive(): Promise<QueueDelivery<T> | null> {
    const item = this.#items.find(
      (candidate) =>
        candidate.leaseToken === null &&
        candidate.availableAt <= this.#clock.now(),
    );
    if (item === undefined) return null;
    item.lockedAt = this.#clock.now();
    item.leaseToken = newId();
    item.deliveryCount += 1;
    return {
      queueItemId: item.queueItemId,
      leaseToken: item.leaseToken,
      deliveryCount: item.deliveryCount,
      message: structuredClone(item.message),
    };
  }

  public async ack(lease: QueueLease): Promise<QueueMutationResult> {
    const index = this.#items.findIndex(
      (item) =>
        item.queueItemId === lease.queueItemId &&
        item.leaseToken === lease.leaseToken,
    );
    if (index < 0) return "stale";
    this.#items.splice(index, 1);
    return "applied";
  }

  public async retry(
    lease: QueueLease,
    message: T,
    delayMs: number,
  ): Promise<QueueMutationResult> {
    const item = this.#items.find(
      (candidate) =>
        candidate.queueItemId === lease.queueItemId &&
        candidate.leaseToken === lease.leaseToken,
    );
    if (item === undefined) return "stale";
    item.message = structuredClone(message);
    item.availableAt = this.#clock.now() + Math.max(0, delayMs);
    item.lockedAt = null;
    item.leaseToken = null;
    return "applied";
  }

  public async depth(): Promise<number> {
    return this.#items.length;
  }

  protected hasMessage(predicate: (message: T) => boolean): boolean {
    return this.#items.some((item) => predicate(item.message));
  }
}

export class InMemoryRawEventQueue
  extends InMemoryQueue<RawEventQueueMessage>
  implements RawEventQueuePort
{
  public override async enqueue(
    message: RawEventQueueMessage,
    delayMs = 0,
  ): Promise<void> {
    if (
      this.hasMessage(
        (candidate) => candidate.rawEventId === message.rawEventId,
      )
    )
      return;
    await super.enqueue(message, delayMs);
  }

  public async hasActive(rawEventId: RawEventId): Promise<boolean> {
    return this.hasMessage((message) => message.rawEventId === rawEventId);
  }
}

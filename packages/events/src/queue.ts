import { newId } from "@zentra/domain";
import type { RawEventId, TraceId } from "@zentra/domain";

export type RawEventQueueMessage = {
  rawEventId: RawEventId;
  traceId: TraceId;
  attempt: number;
};

export type QueueDelivery<T> = {
  deliveryId: string;
  message: T;
};

export interface QueuePort<T> {
  enqueue(message: T, delayMs?: number): Promise<void>;
  receive(): Promise<QueueDelivery<T> | null>;
  ack(deliveryId: string): Promise<void>;
  retry(deliveryId: string, message: T, delayMs: number): Promise<void>;
  depth(): Promise<number>;
}

export interface QueueClock {
  now(): number;
}

type QueueItem<T> = {
  deliveryId: string;
  message: T;
  availableAt: number;
  inFlight: boolean;
};

export class InMemoryQueue<T> implements QueuePort<T> {
  readonly #clock: QueueClock;
  readonly #items: QueueItem<T>[] = [];

  public constructor(clock: QueueClock = { now: () => Date.now() }) {
    this.#clock = clock;
  }

  public async enqueue(message: T, delayMs = 0): Promise<void> {
    this.#items.push({
      deliveryId: newId(),
      message: structuredClone(message),
      availableAt: this.#clock.now() + Math.max(0, delayMs),
      inFlight: false,
    });
  }

  public async receive(): Promise<QueueDelivery<T> | null> {
    const item = this.#items.find(
      (candidate) =>
        !candidate.inFlight && candidate.availableAt <= this.#clock.now(),
    );
    if (item === undefined) return null;
    item.inFlight = true;
    return {
      deliveryId: item.deliveryId,
      message: structuredClone(item.message),
    };
  }

  public async ack(deliveryId: string): Promise<void> {
    const index = this.#items.findIndex(
      (item) => item.deliveryId === deliveryId && item.inFlight,
    );
    if (index >= 0) this.#items.splice(index, 1);
  }

  public async retry(
    deliveryId: string,
    message: T,
    delayMs: number,
  ): Promise<void> {
    const item = this.#items.find(
      (candidate) => candidate.deliveryId === deliveryId && candidate.inFlight,
    );
    if (item === undefined) return;
    item.message = structuredClone(message);
    item.availableAt = this.#clock.now() + Math.max(0, delayMs);
    item.inFlight = false;
  }

  public async depth(): Promise<number> {
    return this.#items.length;
  }
}

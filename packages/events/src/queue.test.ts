import { describe, expect, it } from "vitest";
import { InMemoryQueue } from "./queue.js";

describe("InMemoryQueue", () => {
  it("delivers and acknowledges an enqueued message", async () => {
    const queue = new InMemoryQueue<{ value: number }>();
    await queue.enqueue({ value: 1 });
    const delivery = await queue.receive();
    expect(delivery?.message).toEqual({ value: 1 });
    expect(delivery?.deliveryCount).toBe(1);
    await queue.ack({
      queueItemId: delivery?.queueItemId ?? "missing",
      leaseToken: delivery?.leaseToken ?? "missing",
    });
    expect(await queue.depth()).toBe(0);
  });

  it("does not redeliver a retry before its delay", async () => {
    let now = 100;
    const queue = new InMemoryQueue<{ attempt: number }>({ now: () => now });
    await queue.enqueue({ attempt: 1 });
    const delivery = await queue.receive();
    await queue.retry(
      {
        queueItemId: delivery?.queueItemId ?? "missing",
        leaseToken: delivery?.leaseToken ?? "missing",
      },
      { attempt: 2 },
      50,
    );
    expect(await queue.receive()).toBeNull();
    now = 150;
    const redelivery = await queue.receive();
    expect(redelivery?.message.attempt).toBe(2);
    expect(redelivery?.deliveryCount).toBe(2);
  });

  it("rejects an ACK with a stale fencing token", async () => {
    const queue = new InMemoryQueue<{ value: number }>();
    await queue.enqueue({ value: 1 });
    const delivery = await queue.receive();
    expect(
      await queue.ack({
        queueItemId: delivery?.queueItemId ?? "missing",
        leaseToken: "stale-token",
      }),
    ).toBe("stale");
    expect(await queue.depth()).toBe(1);
  });

  it("rejects a retry with a stale fencing token", async () => {
    const queue = new InMemoryQueue<{ value: number }>();
    await queue.enqueue({ value: 1 });
    const delivery = await queue.receive();
    expect(
      await queue.retry(
        {
          queueItemId: delivery?.queueItemId ?? "missing",
          leaseToken: "stale-token",
        },
        { value: 2 },
        0,
      ),
    ).toBe("stale");
    expect(await queue.depth()).toBe(1);
  });
});

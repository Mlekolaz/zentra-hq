import { describe, expect, it } from "vitest";
import { InMemoryQueue } from "./queue.js";

describe("InMemoryQueue", () => {
  it("delivers and acknowledges an enqueued message", async () => {
    const queue = new InMemoryQueue<{ value: number }>();
    await queue.enqueue({ value: 1 });
    const delivery = await queue.receive();
    expect(delivery?.message).toEqual({ value: 1 });
    await queue.ack(delivery?.deliveryId ?? "missing");
    expect(await queue.depth()).toBe(0);
  });

  it("does not redeliver a retry before its delay", async () => {
    let now = 100;
    const queue = new InMemoryQueue<{ attempt: number }>({ now: () => now });
    await queue.enqueue({ attempt: 1 });
    const delivery = await queue.receive();
    await queue.retry(delivery?.deliveryId ?? "missing", { attempt: 2 }, 50);
    expect(await queue.receive()).toBeNull();
    now = 150;
    expect((await queue.receive())?.message.attempt).toBe(2);
  });
});

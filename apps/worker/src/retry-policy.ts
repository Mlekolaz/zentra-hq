export interface RetryPolicy {
  delayMs(nextAttempt: number): number;
}

export class ExponentialBackoffPolicy implements RetryPolicy {
  public constructor(
    private readonly baseDelayMs = 250,
    private readonly maxDelayMs = 30_000,
    private readonly random: () => number = Math.random,
  ) {}

  public delayMs(nextAttempt: number): number {
    const exponent = Math.max(0, nextAttempt - 2);
    const withoutJitter = Math.min(
      this.maxDelayMs,
      this.baseDelayMs * 2 ** exponent,
    );
    const jitterMultiplier = 0.75 + this.random() * 0.5;
    return Math.round(withoutJitter * jitterMultiplier);
  }
}

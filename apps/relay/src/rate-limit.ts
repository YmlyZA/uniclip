export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const arr = this.hits.get(key) ?? [];
    while (arr.length && arr[0]! < cutoff) arr.shift();
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }

  /** Drop entries for keys no longer in use, called periodically. */
  sweep(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [k, arr] of this.hits) {
      while (arr.length && arr[0]! < cutoff) arr.shift();
      if (arr.length === 0) this.hits.delete(k);
    }
  }
}

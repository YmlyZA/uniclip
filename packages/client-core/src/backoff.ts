export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** 0..1 — fraction of the current delay added/subtracted randomly. */
  jitter: number;
}

export class Backoff {
  private current: number;
  private readonly opts: BackoffOptions;

  constructor(opts: BackoffOptions) {
    this.opts = opts;
    this.current = opts.baseMs;
  }

  next(): number {
    const value = this.current;
    const next = Math.min(value * 2, this.opts.maxMs);
    this.current = next;
    if (this.opts.jitter === 0) return value;
    const swing = value * this.opts.jitter;
    return Math.round(value + (Math.random() * 2 - 1) * swing);
  }

  reset(): void {
    this.current = this.opts.baseMs;
  }
}

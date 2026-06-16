/** How long an item stays on screen in an ephemeral room before auto-removal. */
export const EPHEMERAL_TTL_MS = 60_000;

/**
 * Schedules per-item expiry for ephemeral rooms. One timer per msgId; firing it
 * invokes `onExpire(msgId)`. Timers are reaped via cancel()/clear() (e.g. on
 * component destroy) so a stale timer can't fire after navigation.
 */
export class ExpiryScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly ttlMs: number,
    private readonly onExpire: (msgId: string) => void,
  ) {}

  schedule(msgId: string): void {
    if (this.timers.has(msgId)) return;
    const t = setTimeout(() => {
      this.timers.delete(msgId);
      this.onExpire(msgId);
    }, this.ttlMs);
    this.timers.set(msgId, t);
  }

  cancel(msgId: string): void {
    const t = this.timers.get(msgId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(msgId);
    }
  }

  clear(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

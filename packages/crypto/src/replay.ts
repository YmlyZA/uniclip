/**
 * Bounded set that drops oldest entries when full.
 * Used to reject AES-GCM replayed frames by msgId.
 */
export class ReplaySet {
  readonly capacity: number;
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(capacity = 256) {
    if (capacity < 1) throw new Error("capacity must be >= 1");
    this.capacity = capacity;
  }

  /** Returns true if accepted (new), false if duplicate. */
  admit(msgId: string): boolean {
    if (this.seen.has(msgId)) return false;
    this.seen.add(msgId);
    this.order.push(msgId);
    if (this.order.length > this.capacity) {
      const oldest = this.order.shift()!;
      this.seen.delete(oldest);
    }
    return true;
  }
}

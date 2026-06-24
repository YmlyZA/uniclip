import { encrypt, decrypt, toBase64, fromBase64 } from "@uniclip/crypto";

export type Device = { id: string; name: string; self: boolean };
export interface PresenceFrame { type: "presence"; iv: string; ciphertext: string }

export interface PresenceManagerOptions {
  routingId: string;
  selfId: string;
  getKey: () => CryptoKey | null;
  getName: () => string;
  send: (frame: PresenceFrame) => void;
  emit: (roster: Device[]) => void;
  now?: () => number;
  ttlMs?: number;
  heartbeatMs?: number;
  pruneDelayMs?: number;
}

// Encrypted device presence over the WS relay fan-out. Names never reach the
// relay in clear (Mode A). The roster reconciles via announces + TTL; the relay
// is never the source of device identity. Injectable clock/timers for tests.
export class PresenceManager {
  private readonly opts: PresenceManagerOptions;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly heartbeatMs: number;
  private readonly pruneDelayMs: number;
  private peers = new Map<string, { name: string; lastSeen: number }>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: PresenceManagerOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? 20_000;
    this.heartbeatMs = opts.heartbeatMs ?? 8_000;
    this.pruneDelayMs = opts.pruneDelayMs ?? 2_000;
  }

  private aad(): string {
    return `presence:${this.opts.routingId}`;
  }

  async announce(): Promise<void> {
    const key = this.opts.getKey();
    if (!key) return;
    const env = await encrypt({
      key,
      plaintext: JSON.stringify({ id: this.opts.selfId, name: this.opts.getName() }),
      aad: this.aad(),
    });
    this.opts.send({ type: "presence", iv: toBase64(env.iv), ciphertext: toBase64(env.ciphertext) });
  }

  async handlePresence(frame: PresenceFrame): Promise<void> {
    const key = this.opts.getKey();
    if (!key) return;
    let json: string;
    try {
      json = await decrypt({ key, iv: fromBase64(frame.iv), ciphertext: fromBase64(frame.ciphertext), aad: this.aad() });
    } catch {
      return; // wrong key / tampered → drop
    }
    let data: { id?: unknown; name?: unknown };
    try {
      data = JSON.parse(json);
    } catch {
      return;
    }
    if (typeof data.id !== "string" || typeof data.name !== "string") return;
    if (data.id === this.opts.selfId) return; // our own echo
    this.peers.set(data.id, { name: data.name.slice(0, 40), lastSeen: this.now() });
    this.emitRoster();
  }

  onPeerChange(left: boolean): void {
    void this.announce();
    if (!left) return;
    const at = this.now();
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    this.pruneTimer = setTimeout(() => {
      let changed = false;
      for (const [id, p] of this.peers) {
        if (p.lastSeen < at) {
          this.peers.delete(id);
          changed = true;
        }
      }
      if (changed) this.emitRoster();
    }, this.pruneDelayMs);
  }

  onNameChange(): void {
    void this.announce();
    this.emitRoster();
  }

  start(): void {
    if (this.heartbeatTimer) return;
    void this.announce();
    this.heartbeatTimer = setInterval(() => void this.announce(), this.heartbeatMs);
    this.sweepTimer = setInterval(() => this.tick(), Math.max(1000, Math.floor(this.ttlMs / 4)));
    this.emitRoster();
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    this.heartbeatTimer = null;
    this.sweepTimer = null;
    this.pruneTimer = null;
    this.peers.clear();
    this.emitRoster();
  }

  tick(): void {
    const cutoff = this.now() - this.ttlMs;
    let changed = false;
    for (const [id, p] of this.peers) {
      if (p.lastSeen < cutoff) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) this.emitRoster();
  }

  roster(): Device[] {
    const self: Device = { id: this.opts.selfId, name: this.opts.getName(), self: true };
    const others: Device[] = [...this.peers.entries()].map(([id, p]) => ({ id, name: p.name, self: false }));
    return [self, ...others];
  }

  private emitRoster(): void {
    this.opts.emit(this.roster());
  }
}

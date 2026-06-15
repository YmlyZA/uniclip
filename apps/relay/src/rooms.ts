import {
  generateModeARoom,
  generateModeBCode,
} from "@uniclip/room-code";
import type { ClipboardFrame } from "@uniclip/protocol";
import type { Database } from "bun:sqlite";
import { RoomDb } from "./room-db";

export type RoomMode = "A" | "B";

// How many recent clips a backfill-enabled room buffers for late joiners.
// Matches the client's localStorage history cap; bounded by MAX_FRAME_BYTES each.
export const RECENT_CAP = 50;

export interface Room {
  id: string;
  mode: RoomMode;
  sockets: Set<unknown>; // ServerWebSocket — kept loose for testability
  createdAt: number;
  lastActivityAt: number;
  // Recent ciphertext frames replayed to late joiners. Only ever populated for
  // Mode A (where the relay cannot decrypt), and cleared when the room empties.
  recent: ClipboardFrame[];
  backfillEnabled: boolean;
}

export interface RoomStoreOptions {
  idleTimeoutMs?: number;
  maxAgeMs?: number;
  db?: Database | string;
}

export class RoomStore {
  private readonly rooms = new Map<string, Room>();
  private readonly idleTimeoutMs: number;
  private readonly maxAgeMs: number;
  private readonly roomDb: RoomDb;

  constructor(opts: RoomStoreOptions = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60_000;
    this.maxAgeMs = opts.maxAgeMs ?? 24 * 3600_000;
    this.roomDb = new RoomDb(opts.db ?? ":memory:");
  }

  get count(): number {
    return this.rooms.size;
  }

  // Total rooms that still exist (live in memory OR persisted and not expired).
  // External callers (health, metrics) want this, not `count`, so a metric does
  // not read 0 while idle-evicted rooms still serve valid URLs from the DB.
  get totalCount(): number {
    return this.roomDb.count(Date.now());
  }

  create(mode: RoomMode, backfill = true): Room {
    const id =
      mode === "A" ? generateModeARoom().routingId : generateModeBCode();
    const now = Date.now();
    const room: Room = {
      id,
      mode,
      sockets: new Set(),
      createdAt: now,
      lastActivityAt: now,
      recent: [],
      // Mode B can be decrypted by the relay, so it never buffers regardless of
      // the requested flag — keeping retained data to ciphertext-only (Mode A).
      backfillEnabled: mode === "A" && backfill,
    };
    this.rooms.set(id, room);
    this.roomDb.insert({
      id,
      mode,
      expiresAt: now + this.maxAgeMs,
      backfillEnabled: room.backfillEnabled,
      createdAt: now,
    });
    return room;
  }

  // Buffer a clip for backfill. No-op unless the room buffers (Mode A + enabled),
  // and bounded to the most recent RECENT_CAP frames.
  pushRecent(id: string, frame: ClipboardFrame): void {
    const r = this.rooms.get(id);
    if (!r || !r.backfillEnabled) return;
    r.recent.push(frame);
    if (r.recent.length > RECENT_CAP) {
      r.recent.splice(0, r.recent.length - RECENT_CAP);
    }
  }

  // Drop a clip from the backfill ring (e.g. when it's deleted) so late joiners
  // don't receive an item that no longer exists.
  removeRecent(id: string, msgId: string): void {
    const r = this.rooms.get(id);
    if (!r) return;
    const i = r.recent.findIndex((f) => f.msgId === msgId);
    if (i >= 0) r.recent.splice(i, 1);
  }

  get(id: string): Room | undefined {
    const live = this.rooms.get(id);
    if (live) return live;
    // Map miss: the room may still exist in the DB (survived a restart, or was
    // evicted from memory while idle). Rehydrate it — empty sockets/recent;
    // history only ever lives in memory while a device is connected.
    const rec = this.roomDb.get(id);
    if (!rec) return undefined;
    if (rec.expiresAt <= Date.now()) {
      this.roomDb.delete(id);
      return undefined;
    }
    const room: Room = {
      id: rec.id,
      mode: rec.mode,
      sockets: new Set(),
      createdAt: rec.createdAt,
      lastActivityAt: Date.now(), // idle clock restarts on rehydrate; aged GC (createdAt-based) is the hard 24h ceiling
      recent: [],
      backfillEnabled: rec.backfillEnabled,
    };
    this.rooms.set(id, room);
    return room;
  }

  touch(id: string): void {
    const r = this.rooms.get(id);
    if (r) r.lastActivityAt = Date.now();
  }

  gc(): void {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      const aged = now - room.createdAt > this.maxAgeMs;
      const idle =
        room.sockets.size === 0 && now - room.lastActivityAt > this.idleTimeoutMs;
      if (aged) {
        this.rooms.delete(id);
        this.roomDb.delete(id); // gone for good
      } else if (idle) {
        this.rooms.delete(id); // reclaim memory; DB row survives to max-age
      }
    }
    // Sweep DB rows whose rooms expired while evicted from the Map.
    this.roomDb.deleteExpired(now);
  }
}

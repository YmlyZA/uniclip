import {
  generateModeARoom,
  generateModeBCode,
} from "@uniclip/room-code";
import type { ClipboardFrame } from "@uniclip/protocol";

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
}

export class RoomStore {
  private readonly rooms = new Map<string, Room>();
  private readonly idleTimeoutMs: number;
  private readonly maxAgeMs: number;

  constructor(opts: RoomStoreOptions = {}) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60_000;
    this.maxAgeMs = opts.maxAgeMs ?? 24 * 3600_000;
  }

  get count(): number {
    return this.rooms.size;
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

  get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  touch(id: string): void {
    const r = this.rooms.get(id);
    if (r) r.lastActivityAt = Date.now();
  }

  gc(): void {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      const aged = now - room.createdAt > this.maxAgeMs;
      const idle = room.sockets.size === 0 && now - room.lastActivityAt > this.idleTimeoutMs;
      if (aged || idle) this.rooms.delete(id);
    }
  }
}

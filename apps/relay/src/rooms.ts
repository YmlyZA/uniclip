import {
  generateModeARoom,
  generateModeBCode,
} from "@uniclip/room-code";

export type RoomMode = "A" | "B";

export interface Room {
  id: string;
  mode: RoomMode;
  sockets: Set<unknown>; // ServerWebSocket — kept loose for testability
  createdAt: number;
  lastActivityAt: number;
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

  create(mode: RoomMode): Room {
    const id =
      mode === "A" ? generateModeARoom().routingId : generateModeBCode();
    const now = Date.now();
    const room: Room = {
      id,
      mode,
      sockets: new Set(),
      createdAt: now,
      lastActivityAt: now,
    };
    this.rooms.set(id, room);
    return room;
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

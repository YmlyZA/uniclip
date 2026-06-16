import type { Hono } from "hono";
import { upgradeWebSocket, websocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import {
  CLOSE_CODES,
  ClientFrameSchema,
  MAX_FRAME_BYTES,
  type ServerFrame,
} from "@uniclip/protocol";
import type { RoomStore } from "./rooms";
import { SlidingWindowLimiter } from "./rate-limit";
import type { Metrics } from "./metrics";

export function attachWebSocket(app: Hono, store: RoomStore, metrics?: Metrics) {
  const frameLimiter = new SlidingWindowLimiter(20, 10_000);
  const socketKeys = new WeakMap<ServerWebSocket<{ roomId: string }>, string>();

  app.get(
    "/ws/:roomId",
    upgradeWebSocket((c) => {
      const roomId = c.req.param("roomId") ?? "";
      return {
        onOpen(_ev, ws) {
          const room = store.get(roomId);
          const raw = ws.raw as ServerWebSocket<{ roomId: string }> | undefined;
          if (!raw) return;
          if (!room) {
            raw.close(CLOSE_CODES.ROOM_NOT_FOUND, "ROOM_NOT_FOUND");
            return;
          }
          raw.data.roomId = roomId;
          room.sockets.add(raw);
          store.touch(roomId);
          metrics?.inc("uniclip_sockets_open_total");
          send(raw, {
            type: "hello",
            roomId,
            peerCount: room.sockets.size,
            serverTime: Date.now(),
            backfill: room.backfillEnabled,
            ephemeral: room.ephemeral,
          });
          // Backfill recent clips to this newcomer only — existing peers already
          // have them, and the client's ReplaySet dedups by msgId.
          if (room.backfillEnabled) {
            for (const frame of room.recent) send(raw, frame);
          }
          // Replay deletions to this newcomer too, so a device that was offline
          // when an item was deleted removes it on (re)join. Independent of
          // backfill — a tombstone is a msgId only, and `persist.remove` is a
          // no-op on a device that never had the item.
          for (const msgId of room.tombstones) send(raw, { type: "delete", msgId });
          broadcast(room.sockets, raw, {
            type: "peer-joined",
            peerCount: room.sockets.size,
          });
        },
        onClose(_ev, ws) {
          const raw = ws.raw as ServerWebSocket<{ roomId: string }> | undefined;
          if (!raw) return;
          const room = store.get(raw.data.roomId);
          if (!room) return;
          room.sockets.delete(raw);
          store.touch(room.id);
          // History lives only while the room is occupied: drop the buffer once
          // the last device leaves.
          if (room.sockets.size === 0) {
            room.recent.length = 0;
            room.tombstones.length = 0;
          }
          broadcast(room.sockets, raw, {
            type: "peer-left",
            peerCount: room.sockets.size,
          });
        },
        onMessage(ev, ws) {
          const raw = ws.raw as ServerWebSocket<{ roomId: string }> | undefined;
          if (!raw) return;
          const room = store.get(raw.data.roomId);
          if (!room) return;

          const data = typeof ev.data === "string" ? ev.data : "";
          if (Buffer.byteLength(data, "utf8") > MAX_FRAME_BYTES) {
            metrics?.inc("uniclip_errors_total", 1, { code: "TOO_LARGE" });
            raw.close(CLOSE_CODES.TOO_LARGE, "TOO_LARGE");
            return;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            return;
          }
          const result = ClientFrameSchema.safeParse(parsed);
          if (!result.success) return;

          let key = socketKeys.get(raw);
          if (!key) {
            key = crypto.randomUUID();
            socketKeys.set(raw, key);
          }
          if (!frameLimiter.allow(key)) {
            metrics?.inc("uniclip_errors_total", 1, { code: "RATE_LIMIT" });
            raw.send(
              JSON.stringify({
                type: "error",
                code: "RATE_LIMIT",
                message: "too many frames",
              } satisfies ServerFrame),
            );
            raw.close(CLOSE_CODES.RATE_LIMIT, "RATE_LIMIT");
            return;
          }

          metrics?.inc("uniclip_frames_in_total");
          store.touch(room.id);
          broadcast(room.sockets, raw, result.data, () =>
            metrics?.inc("uniclip_frames_out_total"),
          );
          if (result.data.type === "clip") {
            // Buffer for late joiners (no-op unless Mode A + backfill enabled).
            store.pushRecent(room.id, result.data);
          } else {
            // delete: drop it from the ring so a late joiner won't get it back,
            // and remember it so a peer offline now can reconcile on (re)join.
            store.removeRecent(room.id, result.data.msgId);
            store.addTombstone(room.id, result.data.msgId);
          }
        },
      };
    }),
  );

  return { websocket, fetch: app.fetch, frameLimiter };
}

function send(ws: ServerWebSocket<unknown>, frame: ServerFrame): void {
  ws.send(JSON.stringify(frame));
}

function broadcast(
  sockets: Set<unknown>,
  exclude: ServerWebSocket<unknown>,
  frame: ServerFrame,
  onSent?: () => void,
): void {
  const payload = JSON.stringify(frame);
  for (const s of sockets) {
    if (s === exclude) continue;
    try {
      (s as ServerWebSocket<unknown>).send(payload);
      onSent?.();
    } catch {
      // A failing socket must not block delivery to the rest of the room;
      // its own onClose will reap it from the set.
    }
  }
}

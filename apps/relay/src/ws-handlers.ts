import type { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import {
  CLOSE_CODES,
  ClipboardFrameSchema,
  MAX_FRAME_BYTES,
  type ServerFrame,
} from "@uniclip/protocol";
import type { RoomStore } from "./rooms";
import { SlidingWindowLimiter } from "./rate-limit";

export function attachWebSocket(app: Hono, store: RoomStore) {
  const { upgradeWebSocket, websocket } = createBunWebSocket<{ roomId: string }>();
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
          send(raw, {
            type: "hello",
            roomId,
            peerCount: room.sockets.size,
            serverTime: Date.now(),
          });
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
            raw.close(CLOSE_CODES.TOO_LARGE, "TOO_LARGE");
            return;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            return;
          }
          const result = ClipboardFrameSchema.safeParse(parsed);
          if (!result.success) return;

          let key = socketKeys.get(raw);
          if (!key) {
            key = crypto.randomUUID();
            socketKeys.set(raw, key);
          }
          if (!frameLimiter.allow(key)) {
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

          store.touch(room.id);
          broadcast(room.sockets, raw, result.data);
        },
      };
    }),
  );

  return { websocket, fetch: app.fetch };
}

function send(ws: ServerWebSocket<unknown>, frame: ServerFrame): void {
  ws.send(JSON.stringify(frame));
}

function broadcast(
  sockets: Set<unknown>,
  exclude: ServerWebSocket<unknown>,
  frame: ServerFrame,
): void {
  const payload = JSON.stringify(frame);
  for (const s of sockets) {
    if (s === exclude) continue;
    try {
      (s as ServerWebSocket<unknown>).send(payload);
    } catch {
      // A failing socket must not block delivery to the rest of the room;
      // its own onClose will reap it from the set.
    }
  }
}

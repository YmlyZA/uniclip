import type { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { CLOSE_CODES, type ServerFrame } from "@uniclip/protocol";
import type { RoomStore } from "./rooms";

export function attachWebSocket(app: Hono, store: RoomStore) {
  const { upgradeWebSocket, websocket } = createBunWebSocket<{ roomId: string }>();

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
        onMessage(_ev, _ws) {
          // wired in a later task
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
    (s as ServerWebSocket<unknown>).send(payload);
  }
}

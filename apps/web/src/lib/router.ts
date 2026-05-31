import { parseRoomUrl, type ParsedRoom } from "@uniclip/room-code";

export type Route =
  | { name: "landing" }
  | { name: "room"; room: ParsedRoom };

export function currentRoute(): Route {
  const parsed = parseRoomUrl(window.location.href);
  if (parsed) return { name: "room", room: parsed };
  return { name: "landing" };
}

export function navigateToRoom(routingId: string, secret?: string): void {
  const url = `/r/${routingId}${secret ? `#${secret}` : ""}`;
  window.history.pushState(null, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function navigateHome(): void {
  window.history.pushState(null, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate"));
}

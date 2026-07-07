// Screen-reader label for the header status indicator. On mobile the visible UI
// is only a colored dot (+ a transport glyph), so this carries the full meaning.
type Status = "connecting" | "connected" | "reconnecting" | "disconnected";
type Transport = "p2p" | "relay";

const STATUS_WORD: Record<Status, string> = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Offline",
};

export function statusAriaLabel(status: Status, transport: Transport): string {
  if (status !== "connected") return STATUS_WORD[status];
  return `Connected · ${transport === "p2p" ? "Direct (P2P)" : "Relayed"}`;
}

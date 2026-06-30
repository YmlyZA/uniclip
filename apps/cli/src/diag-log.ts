import type { DiagEvent } from "@uniclip/client-core";

const RELAY_OPEN_MS = 3000;
const P2P_CONNECT_MS = 10000;

export function formatDiagLine(elapsedMs: number, e: DiagEvent): string {
  const t = (elapsedMs / 1000).toFixed(2).padStart(6, " ");
  const mark = e.level === "error" ? "✗" : e.level === "warn" ? "!" : " ";
  return `[${t}s] ${mark} ${e.phase.padEnd(13)} ${e.detail}`;
}

interface AttachOpts {
  now?: () => number;
  write?: (s: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

// Subscribe a verbose stderr logger to a client's diag stream, plus a few
// timing-based environment hints (never gating — advisory lines only).
export function attachDiagLog(
  client: { on(k: "diag", cb: (e: DiagEvent) => void): void },
  opts: AttachOpts = {},
): void {
  const now = opts.now ?? Date.now;
  const write = opts.write ?? ((s: string) => process.stderr.write(s));
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const start = now();
  let relayTimer: unknown;
  let p2pTimer: unknown;
  let sawTransit = false; // any srflx/relay candidate seen

  const hint = (msg: string) => write(`[hint] ! ${msg}\n`);

  client.on("diag", (e) => {
    write(formatDiagLine(now() - start, e) + "\n");

    if (e.phase === "ws" && e.data?.event === "connecting") {
      clearTimer(relayTimer);
      relayTimer = setTimer(() => hint(`relay unreachable — check network/URL (no WS open in ${RELAY_OPEN_MS / 1000}s)`), RELAY_OPEN_MS);
    }
    if (e.phase === "ws" && e.data?.event === "open") {
      clearTimer(relayTimer);
    }
    if (e.phase === "ice-candidate" && (e.data?.typ === "srflx" || e.data?.typ === "relay")) {
      sawTransit = true;
    }
    if (e.phase === "pc-state" && e.data?.state === "connecting") {
      clearTimer(p2pTimer);
      p2pTimer = setTimer(() => {
        if (!sawTransit) hint("no STUN/relay candidates — P2P may be firewalled; will use relay");
      }, P2P_CONNECT_MS);
    }
    if (e.phase === "pc-state" && e.data?.state === "connected") {
      clearTimer(p2pTimer);
    }
  });
}

# CLI Zero-Internet (P4b-ii) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let two `uniclip` CLIs pair and sync with no internet — a host (`uniclip --lan`) runs an embedded WebSocket fan-out advertised over mDNS; a joiner (`uniclip <lan-token>`) discovers it and syncs E2EE text P2P via werift over LAN host candidates.

**Architecture:** The host is simultaneously a relay and a participant: it runs a minimal Node `ws` fan-out (the relay's protocol), advertises it via mDNS, and points its own `UniclipClient` at `ws://127.0.0.1:<port>` — identical to pointing at a public relay. The joiner mDNS-resolves the host and points its `UniclipClient` there. `client-core` is unchanged; all new code is in `apps/cli`.

**Tech Stack:** TypeScript, Node ≥ 22, `ws` (server), `bonjour-service` (mDNS, pure-JS), werift (P4b-i, already present), Ink/React (existing), vitest (plain Node).

## Global Constraints

- **No change to `client-core`, `protocol`, `crypto`, `room-code`, or `apps/relay`.** All new code is in `apps/cli/src/`. Do NOT import `apps/relay` (Bun-only). The embedded relay is a minimal Node `ws` fan-out reusing `@uniclip/protocol` schemas.
- **CLI↔CLI only.** No browser/secure-context work.
- **No persistence, no backfill, no tombstones.** Embedded relay sends `backfill:false`, `ephemeral:true`; holds no state.
- **Mode-A zero-knowledge.** The secret is generated client-side (`generateModeARoom`), embedded only in the QR pairing token's fragment, and NEVER sent in any frame, in the mDNS TXT record, or to the embedded relay. The TXT record carries `routingId` only.
- **werift uses `iceServers: []`** on both host and joiner (LAN host candidates, no STUN — proven to connect).
- The repo uses `exactOptionalPropertyTypes: true`; `pnpm typecheck` must pass. CLI tests run under plain Node vitest (`environment: "node"`), colocated as `*.test.ts(x)` in `apps/cli/src/`.
- **Verified library APIs (use exactly these):**
  - **`ws`:** `new WebSocketServer({ port: 0, host: "0.0.0.0" })`; `wss.on("listening", …)` then `(wss.address() as { port: number }).port` is the ephemeral port; `wss.on("connection", (ws) => …)`; per-socket `ws.on("message", (data: Buffer) => data.toString("utf8"))`, `ws.on("close", …)`, `ws.send(string)`, `ws.readyState === 1` (OPEN); `wss.close()`.
  - **`bonjour-service`:** `import { Bonjour, type Service } from "bonjour-service"`; `const bonjour = new Bonjour()`; publish: `bonjour.publish({ name, type: "uniclip", protocol: "tcp", port, txt: { rid: routingId } })` (the lib forms `_uniclip._tcp`); browse: `bonjour.find({ type: "uniclip", protocol: "tcp" }, (service: Service) => …)`; the discovered `Service` has `.txt` (`service.txt.rid`), `.addresses?: string[]` (IPv4 + IPv6), `.host`, `.port`; cleanup: `bonjour.destroy()`. Prefer an IPv4 from `service.addresses` (`addresses.find(a => a.includes(".") && !a.includes(":"))`), fall back to `service.referer?.address`, then `service.host`.
  - **`@uniclip/protocol`:** `ClientFrameSchema.safeParse(parsed)`, `MAX_FRAME_BYTES`. The `hello` ServerFrame is `.strict()` and REQUIRES `{ type:"hello", roomId, peerCount, serverTime, backfill }` (+ optional `ephemeral`, `protocolVersion`) — omitting `serverTime`/`backfill` makes the client's `ServerFrameSchema.safeParse` reject the hello and it never connects.
  - **`@uniclip/room-code`:** `generateModeARoom(): { routingId: string; secret: string }`; `parseRoomUrl("http://host:port/r/<routingId>#<secret>")` → `{ mode:"A", routingId, secret }`.

---

### Task 1: `lan-token.ts` — format/parse the pairing token

**Files:**
- Create: `apps/cli/src/lan-token.ts`
- Create: `apps/cli/src/lan-token.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `formatLanToken({ routingId, secret }): string` → `uniclip+lan://<routingId>#<secret>`; `parseLanToken(s: string): { routingId: string; secret: string } | null` (null for any non-LAN string, including a normal `https://…/r/…#…` URL).

- [ ] **Step 1: Write the failing test**

Create `apps/cli/src/lan-token.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatLanToken, parseLanToken } from "./lan-token";

describe("lan-token", () => {
  it("round-trips routingId + secret", () => {
    const t = formatLanToken({ routingId: "abc123", secret: "sekretsekretsekret" });
    expect(t).toBe("uniclip+lan://abc123#sekretsekretsekret");
    expect(parseLanToken(t)).toEqual({ routingId: "abc123", secret: "sekretsekretsekret" });
  });
  it("returns null for a normal https room URL (routes to the relay path instead)", () => {
    expect(parseLanToken("https://uniclip.app/r/abc123#sek")).toBeNull();
  });
  it("returns null for garbage and for a token with no secret", () => {
    expect(parseLanToken("not a url")).toBeNull();
    expect(parseLanToken("uniclip+lan://abc123")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/cli && pnpm exec vitest run src/lan-token.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/cli/src/lan-token.ts`:

```ts
// Pairing token for an offline LAN room: uniclip+lan://<routingId>#<secret>.
// routingId identifies the room (also advertised in mDNS TXT); the secret is
// the Mode-A key material and rides ONLY here (in the fragment) — never on the
// wire, never in mDNS. Mirrors the /r/<id>#<secret> URL contract.
const SCHEME = "uniclip+lan://";

export function formatLanToken(room: { routingId: string; secret: string }): string {
  return `${SCHEME}${room.routingId}#${room.secret}`;
}

export function parseLanToken(s: string): { routingId: string; secret: string } | null {
  if (!s.startsWith(SCHEME)) return null;
  const rest = s.slice(SCHEME.length);
  const hash = rest.indexOf("#");
  if (hash < 0) return null;
  const routingId = rest.slice(0, hash);
  const secret = rest.slice(hash + 1);
  if (!routingId || !secret) return null;
  return { routingId, secret };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/cli && pnpm exec vitest run src/lan-token.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/lan-token.ts apps/cli/src/lan-token.test.ts
git commit -m "feat(cli): LAN pairing token format/parse (P4b-ii task 1)"
```

---

### Task 2: `lan-relay.ts` — embedded Node `ws` fan-out

**Files:**
- Modify: `apps/cli/package.json` (add `ws` dep + `@types/ws` devDep + `@uniclip/protocol` workspace dep)
- Create: `apps/cli/src/lan-relay.ts`
- Create: `apps/cli/src/lan-relay.test.ts`

**Interfaces:**
- Consumes: `ws`, `@uniclip/protocol` (`ClientFrameSchema`, `MAX_FRAME_BYTES`).
- Produces: `startLanRelay(opts: { routingId: string; host?: string }): Promise<LanRelay>` where `LanRelay = { port: number; close(): void }`. Single-room fan-out: on connect sends `hello`, broadcasts `peer-joined`; validates frames with `ClientFrameSchema` and fans opaque frames to the *other* sockets; on close broadcasts `peer-left`. Binds `0.0.0.0` by default (LAN-reachable); tests pass `host: "127.0.0.1"`.

- [ ] **Step 1: Add dependencies**

Run: `cd apps/cli && pnpm add ws @uniclip/protocol && pnpm add -D @types/ws`
Expected: `package.json` gains `"ws"` and `"@uniclip/protocol": "workspace:*"` in `dependencies`, `"@types/ws"` in `devDependencies`.

(`@uniclip/protocol` was dropped from the CLI in P4a as unused; the embedded relay needs its schemas, so it returns.)

- [ ] **Step 2: Write the failing test**

Create `apps/cli/src/lan-relay.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startLanRelay } from "./lan-relay";

const RID = "abc123";
let relay: { port: number; close: () => void } | undefined;
afterEach(() => relay?.close());

// Open a ws client and collect parsed frames; resolves once `predicate` is met.
function client(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${RID}`);
  const frames: any[] = [];
  ws.on("message", (d) => frames.push(JSON.parse(d.toString("utf8"))));
  const ready = new Promise<void>((res) => ws.on("open", () => res()));
  const waitFor = (pred: () => boolean, ms = 2000) =>
    new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout waiting on frames: " + JSON.stringify(frames))), ms);
      const i = setInterval(() => { if (pred()) { clearInterval(i); clearTimeout(t); res(); } }, 20);
    });
  return { ws, frames, ready, waitFor, send: (o: unknown) => ws.send(JSON.stringify(o)) };
}

describe("lan-relay", () => {
  it("sends a strict-schema hello on connect", async () => {
    relay = await startLanRelay({ routingId: RID, host: "127.0.0.1" });
    const a = client(relay.port);
    await a.ready;
    await a.waitFor(() => a.frames.some((f) => f.type === "hello"));
    const hello = a.frames.find((f) => f.type === "hello");
    expect(hello).toMatchObject({ type: "hello", roomId: RID, peerCount: 1, backfill: false, ephemeral: true });
    expect(typeof hello.serverTime).toBe("number");
    a.ws.close();
  });

  it("broadcasts peer-joined / peer-left and fans a clip to the OTHER socket only", async () => {
    relay = await startLanRelay({ routingId: RID, host: "127.0.0.1" });
    const a = client(relay.port); await a.ready;
    const b = client(relay.port); await b.ready;
    // a sees peer-joined when b connects
    await a.waitFor(() => a.frames.some((f) => f.type === "peer-joined" && f.peerCount === 2));
    // a sends a clip; b receives it, a does not get it echoed back
    const clip = { type: "clip", msgId: "m1", iv: "i", ciphertext: "c", ts: 1 };
    a.send(clip);
    await b.waitFor(() => b.frames.some((f) => f.type === "clip" && f.msgId === "m1"));
    expect(a.frames.some((f) => f.type === "clip")).toBe(false);
    // b leaves → a sees peer-left
    b.ws.close();
    await a.waitFor(() => a.frames.some((f) => f.type === "peer-left" && f.peerCount === 1));
    a.ws.close();
  });

  it("drops an invalid frame instead of fanning it out", async () => {
    relay = await startLanRelay({ routingId: RID, host: "127.0.0.1" });
    const a = client(relay.port); await a.ready;
    const b = client(relay.port); await b.ready;
    await a.waitFor(() => a.frames.some((f) => f.type === "peer-joined"));
    a.send({ type: "nonsense" });
    a.send({ type: "clip", msgId: "ok", iv: "i", ciphertext: "c", ts: 2 }); // valid, after the junk
    await b.waitFor(() => b.frames.some((f) => f.type === "clip" && f.msgId === "ok"));
    expect(b.frames.some((f) => f.type === "nonsense")).toBe(false);
    a.ws.close(); b.ws.close();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/cli && pnpm exec vitest run src/lan-relay.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `apps/cli/src/lan-relay.ts`:

```ts
import { WebSocketServer, type WebSocket } from "ws";
import { ClientFrameSchema, MAX_FRAME_BYTES } from "@uniclip/protocol";

export interface LanRelay {
  port: number;
  close(): void;
}

// A minimal single-room WebSocket fan-out — the relay's wire protocol with
// everything offline doesn't need stripped out (no backfill, tombstones,
// persistence, rate limiting, or metrics). The host runs this and points its
// own UniclipClient at it; a LAN joiner connects too. Frames stay opaque: the
// relay validates shape and fans ciphertext + signaling to the OTHER sockets.
export function startLanRelay(opts: { routingId: string; host?: string }): Promise<LanRelay> {
  const wss = new WebSocketServer({ port: 0, host: opts.host ?? "0.0.0.0" });
  const sockets = new Set<WebSocket>();

  const broadcast = (from: WebSocket | null, payload: string) => {
    for (const s of sockets) {
      if (s === from) continue;
      if (s.readyState === 1 /* OPEN */) {
        try { s.send(payload); } catch { /* a failing socket must not block the rest */ }
      }
    }
  };

  wss.on("connection", (ws) => {
    sockets.add(ws);
    ws.send(JSON.stringify({
      type: "hello", roomId: opts.routingId, peerCount: sockets.size,
      serverTime: Date.now(), backfill: false, ephemeral: true,
    }));
    broadcast(ws, JSON.stringify({ type: "peer-joined", peerCount: sockets.size }));

    ws.on("message", (data) => {
      const str = data.toString("utf8");
      if (Buffer.byteLength(str, "utf8") > MAX_FRAME_BYTES) return;
      let parsed: unknown;
      try { parsed = JSON.parse(str); } catch { return; }
      if (!ClientFrameSchema.safeParse(parsed).success) return;
      broadcast(ws, str); // re-serialize from the validated shape would be equivalent; str is already validated
    });

    ws.on("close", () => {
      sockets.delete(ws);
      broadcast(null, JSON.stringify({ type: "peer-left", peerCount: sockets.size }));
    });
  });

  return new Promise<LanRelay>((resolve) => {
    wss.on("listening", () => {
      const port = (wss.address() as { port: number }).port;
      resolve({ port, close: () => wss.close() });
    });
  });
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/cli && pnpm exec vitest run src/lan-relay.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/package.json pnpm-lock.yaml apps/cli/src/lan-relay.ts apps/cli/src/lan-relay.test.ts
git commit -m "feat(cli): embedded ws fan-out relay for LAN rooms (P4b-ii task 2)"
```

---

### Task 3: End-to-end gate — embedded relay + two clients + werift sync P2P

The design-gating test (the P4b-i analog): proves the embedded relay + signaling + werift LAN path syncs a real clip, in pure Node with no mDNS. (Validated in planning: this exact scenario connected and synced in ~1.4s.)

**Files:**
- Create: `apps/cli/src/lan-e2e.test.ts`

**Interfaces:**
- Consumes: `startLanRelay` (Task 2), `weriftPeer` (P4b-i), `UniclipClient` (`@uniclip/client-core`), `generateModeARoom` (`@uniclip/room-code`).
- Produces: nothing; transport proof.

- [ ] **Step 1: Write the failing test**

Create `apps/cli/src/lan-e2e.test.ts`:

```ts
import { expect, it } from "vitest";
import { UniclipClient } from "@uniclip/client-core";
import { generateModeARoom } from "@uniclip/room-code";
import { startLanRelay } from "./lan-relay";
import { weriftPeer } from "./werift-peer";

// Embedded relay + two real UniclipClients + werift, connected by known port
// (no mDNS). Proves a clip syncs P2P over the LAN path end-to-end in pure Node.
it("two UniclipClients sync a clip P2P through the embedded LAN relay", async () => {
  const { routingId, secret } = generateModeARoom();
  const relay = await startLanRelay({ routingId, host: "127.0.0.1" });
  const base = `ws://127.0.0.1:${relay.port}`;
  const roomUrl = `http://127.0.0.1:${relay.port}/r/${routingId}#${secret}`;
  const mk = () => new UniclipClient({ roomUrl, relayBase: base, iceServers: [], createConnection: weriftPeer });
  const a = mk(), b = mk();
  const got: string[] = [];
  let aP2P = false, bP2P = false;
  a.on("transport", (t) => { if (t === "p2p") aP2P = true; });
  b.on("transport", (t) => { if (t === "p2p") bP2P = true; });
  b.on("clip", (text) => got.push(text));

  await a.connect();
  await b.connect();

  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("P2P did not establish")), 18000);
    const i = setInterval(() => { if (aP2P && bP2P) { clearInterval(i); clearTimeout(t); res(); } }, 50);
  });

  await a.send("hello over the LAN");
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("clip not received")), 5000);
    const i = setInterval(() => { if (got.length) { clearInterval(i); clearTimeout(t); res(); } }, 50);
  });

  expect(got[0]).toBe("hello over the LAN");
  a.disconnect();
  b.disconnect();
  relay.close();
}, 25000);
```

- [ ] **Step 2: Run to verify it passes**

Run: `cd apps/cli && pnpm exec vitest run src/lan-e2e.test.ts`
Expected: PASS in ~2–4s (transport flips to p2p on both, clip decrypts on b). If it FAILS at "P2P did not establish", the relay isn't fanning signaling (`sdp`/`ice`/`rtc-hello`) — confirm `lan-relay` broadcasts ALL valid frames to the other socket (not just `clip`). Report rather than weaken the assertion.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/lan-e2e.test.ts
git commit -m "test(cli): LAN relay + werift sync clip P2P end-to-end (P4b-ii task 3)"
```

---

### Task 4: `mdns.ts` — discovery behind a testable interface

**Files:**
- Modify: `apps/cli/package.json` (add `bonjour-service` dep)
- Create: `apps/cli/src/mdns.ts`
- Create: `apps/cli/src/mdns.test.ts`

**Interfaces:**
- Consumes: `bonjour-service`.
- Produces:
  - `interface Discovery { advertise(opts: { routingId: string; port: number; name: string }): { stop(): void }; discover(routingId: string, timeoutMs: number): Promise<{ host: string; port: number }>; }`
  - `bonjourDiscovery(): Discovery` — the real implementation.
  - The fake used by wiring tests lives in the test file (and Task 5 reuses the interface).

- [ ] **Step 1: Write the failing test**

Create `apps/cli/src/mdns.test.ts`. Unit-test the IPv4-preference address-pick helper deterministically; the real multicast path is one skip-guarded integration test.

```ts
import { describe, expect, it } from "vitest";
import { pickAddress } from "./mdns";

describe("pickAddress", () => {
  it("prefers an IPv4 from addresses", () => {
    expect(pickAddress({ addresses: ["fe80::1", "192.168.1.5"], host: "host.local", referer: { address: "10.0.0.9" } } as any)).toBe("192.168.1.5");
  });
  it("falls back to referer.address, then host", () => {
    expect(pickAddress({ addresses: ["fe80::1"], host: "host.local", referer: { address: "10.0.0.9" } } as any)).toBe("10.0.0.9");
    expect(pickAddress({ addresses: [], host: "host.local" } as any)).toBe("host.local");
  });
});

// Real multicast advertise→discover. Skipped where the sandbox blocks mDNS
// (common in CI). Not a merge gate — see plan Global Constraints.
describe.skipIf(process.env.CI === "true")("bonjourDiscovery (real multicast)", () => {
  it("advertises a service and discovers it by routingId", async () => {
    const { bonjourDiscovery } = await import("./mdns");
    const d = bonjourDiscovery();
    const rid = "e2e" + Math.floor(performance.now()); // unique per run
    const ad = d.advertise({ routingId: rid, port: 51999, name: "uniclip-test" });
    try {
      const found = await d.discover(rid, 8000);
      expect(found.port).toBe(51999);
    } finally {
      ad.stop();
    }
  }, 12000);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/cli && pnpm exec vitest run src/mdns.test.ts`
Expected: FAIL — `pickAddress` not exported.

- [ ] **Step 3: Implement**

Create `apps/cli/src/mdns.ts`:

```ts
import { Bonjour, type Service } from "bonjour-service";

const SERVICE_TYPE = "uniclip";

export interface Discovery {
  advertise(opts: { routingId: string; port: number; name: string }): { stop(): void };
  discover(routingId: string, timeoutMs: number): Promise<{ host: string; port: number }>;
}

// Choose a connectable address for a discovered service: prefer IPv4 from the
// advertised addresses, then the responder's source address, then the .local
// hostname (last resort — Node's ws may not resolve mDNS hostnames).
export function pickAddress(service: Pick<Service, "addresses" | "host" | "referer">): string {
  const v4 = service.addresses?.find((a) => a.includes(".") && !a.includes(":"));
  return v4 ?? service.referer?.address ?? service.host;
}

export function bonjourDiscovery(): Discovery {
  return {
    advertise({ routingId, port, name }) {
      const bonjour = new Bonjour();
      bonjour.publish({ name, type: SERVICE_TYPE, protocol: "tcp", port, txt: { rid: routingId } });
      return { stop: () => bonjour.destroy() };
    },
    discover(routingId, timeoutMs) {
      const bonjour = new Bonjour();
      return new Promise<{ host: string; port: number }>((resolve, reject) => {
        const timer = setTimeout(() => {
          bonjour.destroy();
          reject(new Error("room not found on this network"));
        }, timeoutMs);
        bonjour.find({ type: SERVICE_TYPE, protocol: "tcp" }, (service: Service) => {
          if (service.txt?.rid !== routingId) return;
          clearTimeout(timer);
          const host = pickAddress(service);
          const port = service.port;
          bonjour.destroy();
          resolve({ host, port });
        });
      });
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/cli && pnpm exec vitest run src/mdns.test.ts`
Expected: PASS (the 2 `pickAddress` tests; the multicast block runs locally if not CI, or is skipped). Typecheck: `cd apps/cli && pnpm typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/package.json pnpm-lock.yaml apps/cli/src/mdns.ts apps/cli/src/mdns.test.ts
git commit -m "feat(cli): mDNS discovery (bonjour-service) behind a Discovery interface (P4b-ii task 4)"
```

---

### Task 5: `lan-session.ts` + `--lan`/token wiring + TUI

**Files:**
- Create: `apps/cli/src/lan-session.ts`
- Modify: `apps/cli/src/args.ts` (+ `apps/cli/src/args.test.ts`)
- Modify: `apps/cli/src/cli.tsx`
- Create: `apps/cli/src/lan-session.test.ts`

**Interfaces:**
- Consumes: `startLanRelay` (T2), `bonjourDiscovery`/`Discovery` (T4), `formatLanToken`/`parseLanToken` (T1), `weriftPeer` (P4b-i), `generateModeARoom`/`parseRoomUrl` (`@uniclip/room-code`), `UniclipClient`, `asciiQr` (existing `qr.ts`).
- Produces:
  - `startLanHost(opts: { deviceName?: string; discovery?: Discovery }): Promise<{ client: UniclipClient; roomUrl: string; token: string; dispose(): void }>`
  - `joinLan(token: string, opts: { deviceName?: string; discovery?: Discovery; timeoutMs?: number }): Promise<{ client: UniclipClient; roomUrl: string; dispose(): void }>`
  - `parseArgs` gains `lan: boolean` (from `--lan`).
  - `cli.tsx` routes: `--lan` → host; positional that `parseLanToken` accepts → join; otherwise existing relay path. `discovery` is injectable (defaults to `bonjourDiscovery()`) so tests use a fake — no multicast.

- [ ] **Step 1: Write the failing `args` test**

Add to `apps/cli/src/args.test.ts`:

```ts
it("parses --lan (default false)", () => {
  expect(parseArgs(["--lan"]).lan).toBe(true);
  expect(parseArgs([]).lan).toBe(false);
});
```

- [ ] **Step 2: Implement `--lan` in `args.ts`**

Add `lan` to the return type, `let lan = false;`, a `else if (a === "--lan") { lan = true; }` branch, and include `lan` in the return (alongside the existing `relay`, optional `roomUrl`/`name`, and `relayOnly` from P4b-i). Run `cd apps/cli && pnpm exec vitest run src/args.test.ts` → PASS.

- [ ] **Step 3: Write the failing `lan-session` test (with a fake Discovery)**

Create `apps/cli/src/lan-session.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { startLanHost, joinLan } from "./lan-session";
import type { Discovery } from "./mdns";

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); });

// A fake Discovery that records the advertised service and serves it back to
// discover() — no multicast, fully deterministic.
function fakeDiscovery() {
  let ad: { routingId: string; port: number } | null = null;
  const d: Discovery = {
    advertise: (o) => { ad = { routingId: o.routingId, port: o.port }; return { stop: () => { ad = null; } }; },
    discover: async (rid) => {
      if (!ad || ad.routingId !== rid) throw new Error("not found");
      return { host: "127.0.0.1", port: ad.port };
    },
  };
  return d;
}

describe("lan-session", () => {
  it("host mints a Mode-A room, runs a relay, advertises it, and yields a matching token", async () => {
    const discovery = fakeDiscovery();
    const host = await startLanHost({ discovery });
    disposers.push(host.dispose);
    // token round-trips to the same room the host is serving
    expect(host.token.startsWith("uniclip+lan://")).toBe(true);
    expect(host.roomUrl).toContain("/r/");
    // a joiner using the same fake discovery resolves to the host's relay and builds a client
    const joiner = await joinLan(host.token, { discovery });
    disposers.push(joiner.dispose);
    expect(joiner.roomUrl).toContain("#"); // carries the secret
  });

  it("joinLan rejects when discovery finds nothing", async () => {
    const discovery = fakeDiscovery(); // nothing advertised
    await expect(joinLan("uniclip+lan://missing#sekretsekretsekret", { discovery, timeoutMs: 200 })).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd apps/cli && pnpm exec vitest run src/lan-session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement `lan-session.ts`**

Create `apps/cli/src/lan-session.ts`:

```ts
import { UniclipClient } from "@uniclip/client-core";
import { generateModeARoom } from "@uniclip/room-code";
import { startLanRelay } from "./lan-relay";
import { bonjourDiscovery, type Discovery } from "./mdns";
import { formatLanToken, parseLanToken } from "./lan-token";
import { weriftPeer } from "./werift-peer";

function deviceServiceName(deviceName?: string): string {
  return `uniclip ${(deviceName ?? "device").slice(0, 30)}`;
}

// Host: mint a Mode-A room locally, run the embedded relay, advertise it over
// mDNS, and point our own UniclipClient at it. No network beyond the LAN.
export async function startLanHost(
  opts: { deviceName?: string; discovery?: Discovery } = {},
): Promise<{ client: UniclipClient; roomUrl: string; token: string; dispose(): void }> {
  const discovery = opts.discovery ?? bonjourDiscovery();
  const { routingId, secret } = generateModeARoom();
  const relay = await startLanRelay({ routingId });
  const ad = discovery.advertise({ routingId, port: relay.port, name: deviceServiceName(opts.deviceName) });
  const roomUrl = `http://127.0.0.1:${relay.port}/r/${routingId}#${secret}`;
  const client = new UniclipClient({
    roomUrl, relayBase: `ws://127.0.0.1:${relay.port}`,
    iceServers: [], createConnection: weriftPeer,
    ...(opts.deviceName ? { deviceName: opts.deviceName } : {}),
  });
  return {
    client, roomUrl, token: formatLanToken({ routingId, secret }),
    dispose: () => { client.disconnect(); ad.stop(); relay.close(); },
  };
}

// Joiner: resolve the host on the LAN by routingId, then connect a UniclipClient.
export async function joinLan(
  token: string,
  opts: { deviceName?: string; discovery?: Discovery; timeoutMs?: number } = {},
): Promise<{ client: UniclipClient; roomUrl: string; dispose(): void }> {
  const parsed = parseLanToken(token);
  if (!parsed) throw new Error("invalid LAN token");
  const discovery = opts.discovery ?? bonjourDiscovery();
  const { host, port } = await discovery.discover(parsed.routingId, opts.timeoutMs ?? 5000);
  const roomUrl = `http://${host}:${port}/r/${parsed.routingId}#${parsed.secret}`;
  const client = new UniclipClient({
    roomUrl, relayBase: `ws://${host}:${port}`,
    iceServers: [], createConnection: weriftPeer,
    ...(opts.deviceName ? { deviceName: opts.deviceName } : {}),
  });
  return { client, roomUrl, dispose: () => client.disconnect() };
}
```

- [ ] **Step 6: Run to verify `lan-session` tests pass**

Run: `cd apps/cli && pnpm exec vitest run src/lan-session.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Wire `cli.tsx`**

Modify `apps/cli/src/cli.tsx` so `main()` routes the three cases. Add near the top of `main`, after `parseArgs`:

```tsx
const { roomUrl: arg, relay, name, relayOnly, lan } = parseArgs(process.argv.slice(2));

// Offline LAN host.
if (lan) {
  const host = await startLanHost({ ...(name ? { deviceName: name } : {}) });
  const qr = await asciiQr(host.token);
  const { waitUntilExit } = render(
    <App client={host.client as any} roomUrl={host.roomUrl} qr={qr} onExit={() => host.dispose()} />,
  );
  await waitUntilExit();
  return;
}

// Offline LAN join (scanned/pasted token).
if (arg && parseLanToken(arg)) {
  let joiner;
  try {
    joiner = await joinLan(arg, { ...(name ? { deviceName: name } : {}) });
  } catch (e) {
    console.error(`Couldn't find that room on this network: ${(e as Error).message}`);
    console.error("Make sure both devices are on the same Wi-Fi/LAN.");
    process.exit(1);
  }
  const { waitUntilExit } = render(
    <App client={joiner.client as any} roomUrl={joiner.roomUrl} qr="" onExit={() => joiner.dispose()} />,
  );
  await waitUntilExit();
  return;
}
// …existing relay-connected path (create-or-join via the public relay) unchanged below…
```

Add imports at the top of `cli.tsx`: `import { startLanHost, joinLan } from "./lan-session";` and `import { parseLanToken } from "./lan-token";`. Leave the existing relay path (createRoom/makeClient) intact for the non-LAN cases.

- [ ] **Step 8: Full CLI suite + typecheck**

Run: `cd apps/cli && pnpm exec vitest run && pnpm typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add apps/cli/src/lan-session.ts apps/cli/src/lan-session.test.ts apps/cli/src/args.ts apps/cli/src/args.test.ts apps/cli/src/cli.tsx
git commit -m "feat(cli): --lan host + LAN-token join wiring (P4b-ii task 5)"
```

---

## Final verification (after all tasks)

- [ ] **Build the bin** — `cd apps/cli && pnpm build`; expect `dist/cli.js` with shebang; `ws` and `bonjour-service` stay external (only `@uniclip/*` is `noExternal`).
- [ ] **Repo-wide gates** — `pnpm typecheck && pnpm test`; expect all packages green (CLI suite incl. lan-token, lan-relay, lan-e2e, mdns pickAddress, lan-session; the multicast test runs locally / is skipped in CI).
- [ ] **Update `CLAUDE.md`** — extend the `apps/cli` bullet: `uniclip --lan` starts an offline LAN host (embedded `ws` fan-out relay + `bonjour-service` mDNS advertise + QR `uniclip+lan://` token); `uniclip <lan-token>` discovers the host via mDNS and syncs P2P over werift with `iceServers: []`; CLI↔CLI only; no persistence; this completes **P4b-ii** (zero-internet). Commit:

```bash
git add CLAUDE.md
git commit -m "docs: CLI zero-internet via mDNS + embedded relay (P4b-ii)"
```

## Self-Review (completed during planning)

- **Spec coverage:** Goal 1 (host, no external network) → T2+T5 (`startLanHost`); Goal 2 (joiner discovers + syncs) → T4+T5 (`joinLan`); Goal 3 (P2P over werift, `iceServers:[]`, relay-as-signaling) → T3 gate (proven in planning); Goal 4 (reuse `UniclipClient` unchanged) → T3/T5 (synthesized `roomUrl`/`relayBase`). Non-goals: no client-core/protocol/relay change (all new code in `apps/cli`; `apps/relay` not imported); CLI↔CLI only; live-only (no backfill/tombstones in `lan-relay`); secret QR-only (TXT carries `rid` only). Decomposition matches spec §8.
- **Placeholder scan:** none. Every step has concrete code and exact commands.
- **Type consistency:** `startLanRelay({routingId, host?}) → {port, close}`, `Discovery.advertise/discover`, `startLanHost/joinLan` return shapes, `parseArgs` `lan` field, and `formatLanToken/parseLanToken` signatures are consistent across T1–T5 and the `cli.tsx` wiring. `hello` includes the strict-required `serverTime`+`backfill`.
- **Known risk surfaced:** the real-multicast mDNS test is skip-guarded in CI (not a merge gate); the deterministic `pickAddress` unit test + the fake-Discovery `lan-session` tests cover the wiring without multicast.

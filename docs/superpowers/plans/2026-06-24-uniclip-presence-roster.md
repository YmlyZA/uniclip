# Presence Roster (P2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live, named roster of the devices in a room — each device self-names; names travel peer-to-peer encrypted (relay blind in Mode A) and the roster reconciles against the relay's `peerCount` with a TTL backstop.

**Architecture:** A new opaque `presence` frame carries an encrypted `{id,name}` blob. An injectable `PresenceManager` in `client-core` (mirroring `FileTransferManager`/`PeerLink`) owns roster state + timers and sends/receives over the **WS** (relay fan-out reaches all peers). `UniclipClient` wires it to presence events; the web app plumbs a per-tab device id + per-origin editable name and renders a roster popover. The relay forwards `presence` opaquely, never persisting it.

**Tech Stack:** TypeScript, Zod (protocol), Bun + Hono (relay), WebCrypto (crypto), Svelte 5 + Tailwind 4 (web), Vitest, Playwright.

## Global Constraints

- **TDD always:** failing test → red → minimal impl → green → commit. (`CLAUDE.md` Conventions.)
- Packages consumed as TS source; no build step.
- **Relay tests run under Bun ≥ 1.3** (`pnpm --filter @uniclip/relay test <pattern>`); relay test JSON cast `(await res.json()) as {...}`.
- **client-core / web tests run in plain Node vitest** (no DOM) — inject fakes; stub globals with `vi.stubGlobal`. WebCrypto-feeding helpers return `Uint8Array<ArrayBuffer>`.
- **Security invariants:** presence is encrypted with the room key under AAD `presence:${routingId}` (disjoint from `${routingId}:${msgId}` clips, `${routingId}:${fileId}:...` files, `persist:${roomId}` at-rest). Relay **never** buffers/tombstones/persists presence. Presence is WS-only in both directions (the `via` guard drops it on the p2p pipe). Device `id` is a random per-tab ULID (sessionStorage) — never a durable fingerprint.
- **Defaults (verbatim):** name ≤ 40 chars; `ttlMs = 20_000`; `heartbeatMs = 8_000`; `pruneDelayMs = 2_000`.
- **Spec:** `docs/superpowers/specs/2026-06-24-uniclip-presence-roster-design.md`.
- **Commit style:** small, scoped; end messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Branch: `feat/presence-roster`.

---

## File Structure

- `packages/protocol/src/index.ts` — `PresenceFrameSchema`; both unions.
- `packages/protocol/src/index.test.ts` — accept/reject.
- `apps/relay/src/ws-handlers.ts` — route `presence` to `signalLimiter`; forward-only.
- `apps/relay/test/signaling.test.ts` — extend: `presence` fans out, not replayed, billed to `signalLimiter`.
- `packages/client-core/src/presence.ts` — new `PresenceManager`.
- `packages/client-core/src/presence.test.ts` — new.
- `packages/client-core/src/client.ts` — construct + wire `PresenceManager`; `presence` event; `setDeviceName`; `via` guard; `deviceId`/`deviceName` options.
- `packages/client-core/src/client.test.ts` — presence over WS reaches manager; presence over p2p dropped; peer events announce.
- `apps/web/src/lib/device-name.ts` — `defaultDeviceName()`; `apps/web/src/lib/device-name.test.ts`.
- `apps/web/src/routes/room.svelte` — device id/name plumbing; subscribe to `presence`.
- `apps/web/src/components/roster-popover.svelte` — new roster UI.
- `apps/web/src/components/share-modal.svelte` — Safari-safe scrim fold-in.

---

## Task 1: Protocol — `presence` frame

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/index.test.ts`

**Interfaces:**
- Produces: `PresenceFrameSchema` (`{ type: "presence", iv: Base64, ciphertext: Base64 }`), in both `ClientFrameSchema` and `ServerFrameSchema`.

- [ ] **Step 1: Write the failing test**

Append to `packages/protocol/src/index.test.ts`:

```ts
describe("presence frame", () => {
  it("accepts a valid presence frame on both unions", () => {
    const f = { type: "presence", iv: "AAAA", ciphertext: "QUFB" };
    expect(ClientFrameSchema.parse(f)).toBeDefined();
    expect(ServerFrameSchema.parse(f)).toBeDefined();
  });
  it("rejects missing fields and extra keys", () => {
    expect(() => ClientFrameSchema.parse({ type: "presence", iv: "AAAA" })).toThrow();
    expect(() => ClientFrameSchema.parse({ type: "presence", iv: "AAAA", ciphertext: "QUFB", x: 1 })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uniclip/protocol test "presence frame"`
Expected: FAIL — `presence` not in the unions.

- [ ] **Step 3: Implement the schema**

In `packages/protocol/src/index.ts`, add after `RtcHelloSchema` (reuse the existing `Base64` helper at the top of the file):

```ts
// Encrypted device-presence announce (named roster). Opaque to the relay
// (fanned out, never buffered). Plaintext under `ciphertext` is
// JSON {id,name}, encrypted with the room key under AAD `presence:${routingId}`.
export const PresenceFrameSchema = z
  .object({ type: z.literal("presence"), iv: Base64, ciphertext: Base64 })
  .strict();
```

Add `PresenceFrameSchema` to **both** unions (alongside the signaling frames):

```ts
export const ServerFrameSchema = z.discriminatedUnion("type", [
  // …existing…
  RtcHelloSchema,
  PresenceFrameSchema,
]);
```
```ts
export const ClientFrameSchema = z.discriminatedUnion("type", [
  // …existing…
  RtcHelloSchema,
  PresenceFrameSchema,
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @uniclip/protocol test "presence frame"` → PASS. Then `pnpm --filter @uniclip/protocol typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/index.ts packages/protocol/src/index.test.ts
git commit -m "feat(protocol): encrypted presence frame for the device roster

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Relay — route `presence` to the signaling budget

**Files:**
- Modify: `apps/relay/src/ws-handlers.ts`
- Test: `apps/relay/test/signaling.test.ts`

**Interfaces:**
- Consumes: `presence` is now a valid `ClientFrame` (Task 1); `broadcast` already forwards it.
- Produces: `presence` billed to `signalLimiter`; never buffered.

- [ ] **Step 1: Write the failing test**

Append to `apps/relay/test/signaling.test.ts` (reuse its `mintRoom`/`open` helpers):

```ts
it("fans out presence to the other peer, never replays it, and uses the signal budget", async () => {
  const id = await mintRoom();
  const a = await open(`${baseWs}/ws/${id}`);
  const b = await open(`${baseWs}/ws/${id}`);
  await new Promise((r) => setTimeout(r, 30));
  a.ws.send(JSON.stringify({ type: "presence", iv: "AAAA", ciphertext: "QUFB" }));
  await new Promise((r) => setTimeout(r, 30));
  expect(b.messages.some((m) => m.type === "presence" && m.ciphertext === "QUFB")).toBe(true);
  expect(a.messages.some((m) => m.type === "presence")).toBe(false); // not echoed
  const c = await open(`${baseWs}/ws/${id}`);
  await new Promise((r) => setTimeout(r, 30));
  expect(c.messages.some((m) => m.type === "presence")).toBe(false); // not buffered
  a.ws.close(); b.ws.close(); c.ws.close();
});

it("bills presence to the signalLimiter, not the clip limiter", async () => {
  const id = await mintRoom();
  const a = await open(`${baseWs}/ws/${id}`);
  await open(`${baseWs}/ws/${id}`);
  await new Promise((r) => setTimeout(r, 20));
  let closed = false;
  a.ws.onclose = () => (closed = true);
  for (let i = 0; i < 60; i++) a.ws.send(JSON.stringify({ type: "presence", iv: "AAAA", ciphertext: "QUFB" }));
  await new Promise((r) => setTimeout(r, 60));
  expect(closed).toBe(false); // 60 > clip limit (20), < signal limit (200)
  a.ws.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uniclip/relay test signaling`
Expected: the trickle test FAILS (60 presence frames billed to `frameLimiter` window 20 → socket closed). (Fan-out passes already.)

- [ ] **Step 3: Implement the routing**

In `apps/relay/src/ws-handlers.ts`, extend the limiter ternary to include `presence`:

```ts
          const t = result.data.type;
          const limiter =
            t === "sdp" || t === "ice" || t === "rtc-hello" || t === "presence" ? signalLimiter
            : t.startsWith("file-") ? chunkLimiter
            : frameLimiter;
```

Update the forward-only comment to add `presence`:

```ts
          // file-* and sdp/ice/rtc-hello/presence frames are forwarded only
          // (already broadcast above) — never buffered, tombstoned, or
          // persisted. Binary stays out of the relay; signaling and presence
          // are ephemeral and must not reach late joiners.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @uniclip/relay test signaling` → PASS. Then `pnpm --filter @uniclip/relay typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/ws-handlers.ts apps/relay/test/signaling.test.ts
git commit -m "feat(relay): bill presence frames to the signaling rate budget

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: client-core — `PresenceManager` + `UniclipClient` wiring

**Files:**
- Create: `packages/client-core/src/presence.ts`
- Test: `packages/client-core/src/presence.test.ts`
- Modify: `packages/client-core/src/client.ts`, `packages/client-core/src/client.test.ts`

**Interfaces:**
- Consumes: `encrypt`/`decrypt`/`toBase64`/`fromBase64` from `@uniclip/crypto`.
- Produces:
  ```ts
  export type Device = { id: string; name: string; self: boolean };
  export interface PresenceFrame { type: "presence"; iv: string; ciphertext: string }
  export class PresenceManager {
    constructor(opts: PresenceManagerOptions);
    announce(): Promise<void>;
    handlePresence(frame: PresenceFrame): Promise<void>;
    onPeerChange(left: boolean): void;
    onNameChange(): void;
    start(): void;
    stop(): void;
    tick(): void;          // runs TTL eviction (called by the sweep timer; public for tests)
    roster(): Device[];    // self first
  }
  ```
  `UniclipClient`: new `presence` event `{ kind:"presence"; roster: Device[] }` + handler `presence: (roster: Device[]) => void`; new methods `setDeviceName(name: string): void`; new options `deviceId?: string`, `deviceName?: string`.

- [ ] **Step 1: Write the PresenceManager tests (RED)**

Create `packages/client-core/src/presence.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { deriveKey } from "@uniclip/crypto";
import { PresenceManager, type Device } from "./presence";

// client-core tests run in Node; ensure WebCrypto is present.
if (!globalThis.crypto) vi.stubGlobal("crypto", webcrypto);

async function key() {
  return deriveKey({ secret: "presence-test-secret", salt: "salt", extractable: false });
}

function mk(over: Partial<Parameters<typeof PresenceManager.prototype.constructor>[0]> = {}) {
  const sent: { iv: string; ciphertext: string }[] = [];
  const rosters: Device[][] = [];
  let cryptoKey: CryptoKey | null = null;
  let name = "Laptop";
  let t = 1_000;
  const mgr = new PresenceManager({
    routingId: "room1",
    selfId: "SELF",
    getKey: () => cryptoKey,
    getName: () => name,
    send: (f) => sent.push({ iv: f.iv, ciphertext: f.ciphertext }),
    emit: (r) => rosters.push(r),
    now: () => t,
    ttlMs: 20_000,
    heartbeatMs: 8_000,
    pruneDelayMs: 2_000,
    ...over,
  });
  return {
    mgr, sent, rosters,
    setKey: (k: CryptoKey | null) => (cryptoKey = k),
    setName: (n: string) => (name = n),
    setNow: (n: number) => (t = n),
  };
}

afterEach(() => vi.useRealTimers());

it("announce encrypts {id,name} and sends a presence frame", async () => {
  const h = mk();
  h.setKey(await key());
  await h.mgr.announce();
  expect(h.sent).toHaveLength(1);
  expect(typeof h.sent[0]!.iv).toBe("string");
  expect(typeof h.sent[0]!.ciphertext).toBe("string");
});

it("announce is a no-op with no key", async () => {
  const h = mk();
  await h.mgr.announce();
  expect(h.sent).toHaveLength(0);
});

it("handlePresence upserts a peer (decrypted) and emits; ignores own id and bad blobs", async () => {
  const k = await key();
  // Build a real peer frame by using a second manager with a different self id.
  const peer = mk({ selfId: "PEER" });
  peer.setKey(k);
  peer.setName("Phone");
  await peer.mgr.announce();
  const frame = { type: "presence" as const, ...peer.sent[0]! };

  const me = mk({ selfId: "SELF" });
  me.setKey(k);
  await me.mgr.handlePresence(frame);
  const roster = me.rosters.at(-1)!;
  expect(roster.some((d) => d.id === "PEER" && d.name === "Phone" && !d.self)).toBe(true);

  // Own id ignored
  const mine = mk({ selfId: "PEER" }); // same id as the frame's author
  mine.setKey(k);
  await mine.mgr.handlePresence(frame);
  expect(mine.rosters).toHaveLength(0);

  // Undecryptable blob dropped
  const other = mk({ selfId: "SELF" });
  other.setKey(await deriveKey({ secret: "different", salt: "salt", extractable: false }));
  await other.mgr.handlePresence(frame);
  expect(other.rosters).toHaveLength(0);
});

it("TTL eviction removes a stale peer on tick()", async () => {
  const k = await key();
  const peer = mk({ selfId: "PEER" }); peer.setKey(k); peer.setName("Phone");
  await peer.mgr.announce();
  const frame = { type: "presence" as const, ...peer.sent[0]! };

  const me = mk(); me.setKey(k); me.setNow(1_000);
  await me.mgr.handlePresence(frame);              // lastSeen = 1_000
  expect(me.mgr.roster().some((d) => d.id === "PEER")).toBe(true);
  me.setNow(1_000 + 20_001);                       // past ttl
  me.mgr.tick();
  expect(me.mgr.roster().some((d) => d.id === "PEER")).toBe(false);
});

it("fast prune on peer-left drops a non-refreshed peer within pruneDelayMs", async () => {
  vi.useFakeTimers();
  const k = await key();
  const peer = mk({ selfId: "GONE" }); peer.setKey(k); peer.setName("Old");
  await peer.mgr.announce();
  const frame = { type: "presence" as const, ...peer.sent[0]! };

  const me = mk(); me.setKey(k); me.setNow(1_000);
  await me.mgr.handlePresence(frame);              // GONE lastSeen = 1_000
  me.setNow(5_000);
  me.mgr.onPeerChange(true);                       // peer-left at now=5_000; schedules prune
  await vi.advanceTimersByTimeAsync(2_000);
  expect(me.mgr.roster().some((d) => d.id === "GONE")).toBe(false);
});

it("roster() lists self first", () => {
  const h = mk();
  const r = h.mgr.roster();
  expect(r[0]).toEqual({ id: "SELF", name: "Laptop", self: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @uniclip/client-core test presence`
Expected: FAIL — `./presence` does not exist.

- [ ] **Step 3: Implement `PresenceManager`**

Create `packages/client-core/src/presence.ts`:

```ts
import { encrypt, decrypt, toBase64, fromBase64 } from "@uniclip/crypto";

export type Device = { id: string; name: string; self: boolean };
export interface PresenceFrame { type: "presence"; iv: string; ciphertext: string }

export interface PresenceManagerOptions {
  routingId: string;
  selfId: string;
  getKey: () => CryptoKey | null;
  getName: () => string;
  send: (frame: PresenceFrame) => void;
  emit: (roster: Device[]) => void;
  now?: () => number;
  ttlMs?: number;
  heartbeatMs?: number;
  pruneDelayMs?: number;
}

// Encrypted device presence over the WS relay fan-out. Names never reach the
// relay in clear (Mode A). The roster reconciles via announces + TTL; the relay
// is never the source of device identity. Injectable clock/timers for tests.
export class PresenceManager {
  private readonly opts: PresenceManagerOptions;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly heartbeatMs: number;
  private readonly pruneDelayMs: number;
  private peers = new Map<string, { name: string; lastSeen: number }>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: PresenceManagerOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? 20_000;
    this.heartbeatMs = opts.heartbeatMs ?? 8_000;
    this.pruneDelayMs = opts.pruneDelayMs ?? 2_000;
  }

  private aad(): string {
    return `presence:${this.opts.routingId}`;
  }

  async announce(): Promise<void> {
    const key = this.opts.getKey();
    if (!key) return;
    const env = await encrypt({
      key,
      plaintext: JSON.stringify({ id: this.opts.selfId, name: this.opts.getName() }),
      aad: this.aad(),
    });
    this.opts.send({ type: "presence", iv: toBase64(env.iv), ciphertext: toBase64(env.ciphertext) });
  }

  async handlePresence(frame: PresenceFrame): Promise<void> {
    const key = this.opts.getKey();
    if (!key) return;
    let json: string;
    try {
      json = await decrypt({ key, iv: fromBase64(frame.iv), ciphertext: fromBase64(frame.ciphertext), aad: this.aad() });
    } catch {
      return; // wrong key / tampered → drop
    }
    let data: { id?: unknown; name?: unknown };
    try {
      data = JSON.parse(json);
    } catch {
      return;
    }
    if (typeof data.id !== "string" || typeof data.name !== "string") return;
    if (data.id === this.opts.selfId) return; // our own echo
    this.peers.set(data.id, { name: data.name.slice(0, 40), lastSeen: this.now() });
    this.emitRoster();
  }

  onPeerChange(left: boolean): void {
    void this.announce();
    if (!left) return;
    const at = this.now();
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    this.pruneTimer = setTimeout(() => {
      let changed = false;
      for (const [id, p] of this.peers) {
        if (p.lastSeen < at) {
          this.peers.delete(id);
          changed = true;
        }
      }
      if (changed) this.emitRoster();
    }, this.pruneDelayMs);
  }

  onNameChange(): void {
    void this.announce();
    this.emitRoster();
  }

  start(): void {
    if (this.heartbeatTimer) return;
    void this.announce();
    this.heartbeatTimer = setInterval(() => void this.announce(), this.heartbeatMs);
    this.sweepTimer = setInterval(() => this.tick(), Math.max(1000, Math.floor(this.ttlMs / 4)));
    this.emitRoster();
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    this.heartbeatTimer = null;
    this.sweepTimer = null;
    this.pruneTimer = null;
    this.peers.clear();
    this.emitRoster();
  }

  tick(): void {
    const cutoff = this.now() - this.ttlMs;
    let changed = false;
    for (const [id, p] of this.peers) {
      if (p.lastSeen < cutoff) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) this.emitRoster();
  }

  roster(): Device[] {
    const self: Device = { id: this.opts.selfId, name: this.opts.getName(), self: true };
    const others: Device[] = [...this.peers.entries()].map(([id, p]) => ({ id, name: p.name, self: false }));
    return [self, ...others];
  }

  private emitRoster(): void {
    this.opts.emit(this.roster());
  }
}
```

- [ ] **Step 4: Run the PresenceManager tests (GREEN)**

Run: `pnpm --filter @uniclip/client-core test presence` → PASS (7 tests). `pnpm --filter @uniclip/client-core typecheck` → clean.

> If `deriveKey`'s option names differ from `{ secret, salt, extractable }`, check `packages/crypto/src/index.ts` exports and adjust the test's `key()` helper to the real signature (the manager code does not depend on it — only the test builds a key).

- [ ] **Step 5: Write the UniclipClient wiring tests (RED)**

Append to `packages/client-core/src/client.test.ts`:

```ts
describe("UniclipClient presence", () => {
  it("surfaces a presence roster from a frame received over the WS", async () => {
    // Two clients in the same room so the presence blob decrypts.
    const url = "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr";
    const a = new UniclipClient({ roomUrl: url, relayBase: "wss://uniclip.app", deviceId: "A", deviceName: "Alice" });
    await a.connect();
    const wsA = MockWebSocket.instances.at(-1)!;
    wsA.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    // a announced over the WS; capture the presence frame it sent
    await waitFor(() => wsA.sent.some((p) => JSON.parse(p).type === "presence"));
    const presenceFrame = JSON.parse(wsA.sent.find((p) => JSON.parse(p).type === "presence")!);

    const b = new UniclipClient({ roomUrl: url, relayBase: "wss://uniclip.app", deviceId: "B", deviceName: "Bob" });
    const rosters: any[] = [];
    b.on("presence", (r: any) => rosters.push(r));
    await b.connect();
    const wsB = MockWebSocket.instances.at(-1)!;
    wsB.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    wsB.emit(presenceFrame); // A's presence arrives at B over the WS
    await waitFor(() => rosters.some((r) => r.some((d: any) => d.id === "A" && d.name === "Alice")));
    expect(rosters.at(-1).some((d: any) => d.self && d.id === "B")).toBe(true);
  });

  it("drops a presence frame arriving over the p2p pipe", async () => {
    const url = "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr";
    const a = new UniclipClient({ roomUrl: url, relayBase: "wss://uniclip.app", deviceId: "A", deviceName: "Alice" });
    await a.connect();
    const wsA = MockWebSocket.instances.at(-1)!;
    wsA.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    await waitFor(() => wsA.sent.some((p) => JSON.parse(p).type === "presence"));
    const presenceFrame = JSON.parse(wsA.sent.find((p) => JSON.parse(p).type === "presence")!);

    const b = new UniclipClient({
      roomUrl: url, relayBase: "wss://uniclip.app", deviceId: "B", deviceName: "Bob",
      iceServers: [], createConnection: fakePcFactory(),
    });
    const rosters: any[] = [];
    b.on("presence", (r: any) => rosters.push(r));
    await b.connect();
    const wsB = MockWebSocket.instances.at(-1)!;
    wsB.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    wsB.emit({ type: "rtc-hello", from: "00000000000000000000000000" }); // open p2p
    await waitFor(() => (b as any).transport === "p2p" || true);
    // Deliver A's presence over the data channel (p2p pipe); it must be ignored.
    const before = rosters.length;
    const ch = fakeChannelOf(wsB); // helper: grab the open fake data channel
    ch.onmessage?.({ data: JSON.stringify(presenceFrame) });
    await new Promise((r) => setTimeout(r, 10));
    // No new roster entry for A (the p2p-delivered presence was dropped).
    expect(rosters.slice(before).some((r: any) => r.some((d: any) => d.id === "A"))).toBe(false);
  });
});
```

> The second test needs a way to reach the open fake data channel. If the existing `fakePcFactory` already exposes its channel (e.g. via a captured reference), use that; otherwise add a tiny helper in the test file that records the channel the factory created. If wiring the p2p channel proves awkward in this harness, an acceptable equivalent is to call the client's frame handler with the p2p pipe directly via the existing transport-test seam used by the `sdp`/`ice` via-guard test — match whatever that test does.

- [ ] **Step 6: Run the client tests to verify they fail**

Run: `pnpm --filter @uniclip/client-core test client`
Expected: FAIL — no `presence` event / `deviceId` option / presence handling.

- [ ] **Step 7: Implement the UniclipClient wiring**

In `packages/client-core/src/client.ts`:

(a) Import and event/handler/option additions:

```ts
import { PresenceManager, type Device, type PresenceFrame } from "./presence";
```
Add to `ClientEvent`: `| { kind: "presence"; roster: Device[] }`.
Add to `EventHandlers`: `presence: (roster: Device[]) => void;`.
Add to `UniclipClientOptions`: `deviceId?: string; deviceName?: string;`.

(b) Fields + constructor (construct alongside `transfers`):

```ts
  private presence!: PresenceManager;
  private deviceName: string;
```
In the constructor, after `this.createConnection = opts.createConnection;`:
```ts
    this.deviceName = (opts.deviceName ?? "This device").slice(0, 40);
    const selfId = opts.deviceId ?? ulid();
    this.presence = new PresenceManager({
      routingId: this.room.routingId,
      selfId,
      getKey: () => this.key,
      getName: () => this.deviceName,
      send: (frame: PresenceFrame) => {
        // Presence rides the WS so the relay fans it to ALL peers (rooms can be >2).
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
      },
      emit: (roster) => this.emit({ kind: "presence", roster }),
    });
```

(c) `emit()` switch — add:
```ts
        case "presence": (cb as EventHandlers["presence"])(evt.roster); break;
```

(d) `handleFrame` — presence routing + the `via` guard, and presence lifecycle on presence events:
```ts
      case "hello":
        this.emit({ kind: "status", value: "connected" });
        this.emit({ kind: "peer", count: frame.peerCount });
        this.emit({ kind: "room", backfill: frame.backfill, ephemeral: frame.ephemeral });
        this.flushQueue();
        if (frame.peerCount >= 2) this.armPeer();
        this.presence.start(); // idempotent; announces self + starts heartbeat/sweep
        return;
      case "peer-joined":
        this.emit({ kind: "peer", count: frame.peerCount });
        if (frame.peerCount >= 2 && !this.peer) this.armPeer();
        this.presence.onPeerChange(false);
        return;
      case "peer-left":
        this.emit({ kind: "peer", count: frame.peerCount });
        if (frame.peerCount < 2) this.teardownPeer();
        this.presence.onPeerChange(true);
        return;
```
Extend the signaling guard case to include `presence`:
```ts
      case "sdp":
      case "ice":
      case "rtc-hello":
        if (via !== "ws") return;
        await this.peer?.handleSignal(frame as PeerSignal);
        return;
      case "presence":
        if (via !== "ws") return;
        await this.presence.handlePresence(frame);
        return;
```

(e) New method + teardown:
```ts
  setDeviceName(name: string): void {
    this.deviceName = name.slice(0, 40);
    this.presence.onNameChange();
  }
```
In `handleClose()` (after `this.teardownPeer();`) and in `disconnect()` (after `this.peer?.close();`), add:
```ts
    this.presence.stop();
```

- [ ] **Step 8: Run the full client-core suite (GREEN)**

Run: `pnpm --filter @uniclip/client-core test` → PASS (presence 7 + client incl. 2 new + existing). `pnpm --filter @uniclip/client-core typecheck` → clean.

- [ ] **Step 9: Commit**

```bash
git add packages/client-core/src/presence.ts packages/client-core/src/presence.test.ts packages/client-core/src/client.ts packages/client-core/src/client.test.ts
git commit -m "feat(client-core): PresenceManager — encrypted device roster over the WS

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: web — device name plumbing + roster popover

**Files:**
- Create: `apps/web/src/lib/device-name.ts`, `apps/web/src/lib/device-name.test.ts`
- Create: `apps/web/src/components/roster-popover.svelte`
- Modify: `apps/web/src/routes/room.svelte`, `apps/web/src/components/share-modal.svelte`

**Interfaces:**
- Consumes: `client.on("presence", …)`, `client.setDeviceName(name)`, `UniclipClientOptions.deviceId`/`deviceName` (Task 3).
- Produces: `defaultDeviceName(): string`.

- [ ] **Step 1: Write the `defaultDeviceName` test (RED)**

Create `apps/web/src/lib/device-name.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDeviceName } from "./device-name";

afterEach(() => vi.unstubAllGlobals());

it("derives a Browser · OS label from a Chrome/macOS UA", () => {
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36" });
  expect(defaultDeviceName()).toBe("Chrome · macOS");
});

it("derives Safari · iPhone from an iOS Safari UA", () => {
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" });
  expect(defaultDeviceName()).toBe("Safari · iPhone");
});

it("falls back to 'This device' when the UA is unrecognized", () => {
  vi.stubGlobal("navigator", { userAgent: "something-weird" });
  expect(defaultDeviceName()).toBe("This device");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @uniclip/web test device-name`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `defaultDeviceName`**

Create `apps/web/src/lib/device-name.ts`:

```ts
// A friendly "<Browser> · <OS>" label from the UA, for the default device name.
// Order matters: Edge/Chrome both contain "Chrome"; iOS contains "like Mac OS X".
export function defaultDeviceName(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Version\/.*Safari/.test(ua) ? "Safari"
    : "";
  const os =
    /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
    : /Android/.test(ua) ? "Android"
    : /Macintosh|Mac OS X/.test(ua) ? "macOS"
    : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : "";
  if (browser && os) return `${browser} · ${os}`;
  return "This device";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @uniclip/web test device-name` → PASS. `pnpm --filter @uniclip/web typecheck` → clean.

- [ ] **Step 5: Create the roster popover component**

Create `apps/web/src/components/roster-popover.svelte`:

```svelte
<script lang="ts">
  type Device = { id: string; name: string; self: boolean };
  let { roster, onRename, onClose }: { roster: Device[]; onRename: (name: string) => void; onClose: () => void } = $props();
  const self = $derived(roster.find((d) => d.self));
  const others = $derived(roster.filter((d) => !d.self));
  let editing = $state(false);
  let draft = $state("");

  function startEdit() {
    draft = self?.name ?? "";
    editing = true;
  }
  function save() {
    const name = draft.trim().slice(0, 40);
    if (name) onRename(name);
    editing = false;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="w-64 overflow-hidden rounded-card border border-border bg-elevated p-2 shadow-[var(--shadow-card)]" role="dialog" aria-label="Connected devices">
  <div class="flex items-center justify-between gap-2 rounded-field bg-surface-2 px-3 py-2">
    {#if editing}
      <input
        bind:value={draft}
        maxlength="40"
        class="min-w-0 flex-1 bg-transparent text-sm text-text focus:outline-none"
        onkeydown={(e) => { if (e.key === "Enter") save(); }}
        onblur={save}
        aria-label="Your device name"
      />
    {:else}
      <span class="min-w-0 flex-1 truncate text-sm font-medium text-text">{self?.name}</span>
      <span class="shrink-0 text-[11px] text-accent">This device</span>
      <button type="button" onclick={startEdit} class="shrink-0 text-xs text-muted hover:text-text" aria-label="Rename this device">Edit</button>
    {/if}
  </div>
  {#each others as d (d.id)}
    <div class="flex items-center gap-2 px-3 py-2 text-sm text-text">
      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"></span>
      <span class="min-w-0 flex-1 truncate">{d.name}</span>
    </div>
  {/each}
  {#if others.length === 0}
    <p class="px-3 py-2 text-xs text-muted">Only this device is connected.</p>
  {/if}
</div>
```

- [ ] **Step 6: Plumb device id/name + roster into `room.svelte`**

In `apps/web/src/routes/room.svelte`:
- Add imports: `import { defaultDeviceName } from "../lib/device-name";` and `import RosterPopover from "../components/roster-popover.svelte";`.
- Before constructing `UniclipClient`, resolve identity:
```ts
  function deviceId(): string {
    const k = "uniclip.deviceId";
    let id = sessionStorage.getItem(k);
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(k, id); }
    return id;
  }
  let deviceName = $state(localStorage.getItem("uniclip.deviceName") || defaultDeviceName());
  let roster = $state<{ id: string; name: string; self: boolean }[]>([]);
  let showRoster = $state(false);
```
- Pass `deviceId: deviceId(), deviceName` into the `new UniclipClient({...})` options.
- Subscribe: `c.on("presence", (r) => (roster = r));`
- Rename handler:
```ts
  function renameDevice(name: string) {
    deviceName = name;
    localStorage.setItem("uniclip.deviceName", name);
    client?.setDeviceName(name);
  }
```
- Render the popover near the peer/count indicator (in the header area where `{peerCount}` is shown), e.g.:
```svelte
  <div class="relative">
    <button type="button" onclick={() => (showRoster = !showRoster)} class="..." aria-label="Connected devices">
      {peerCount}
    </button>
    {#if showRoster}
      <div class="absolute right-0 z-40 mt-2">
        <RosterPopover {roster} onRename={renameDevice} onClose={() => (showRoster = false)} />
      </div>
    {/if}
  </div>
```
(Adapt the trigger to the existing peer indicator markup; keep its current count display.)

- [ ] **Step 7: Fold-in — fix the share-modal scrim for Safari**

In `apps/web/src/components/share-modal.svelte`, change the overlay `class` at line ~36 from `... bg-black/55 p-4 backdrop-blur-sm ...` to a `scrim` class and add a scoped style (mirror `composer-modal.svelte`):

```svelte
<div class="scrim fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center" role="presentation" ...>
```
Append at the end of the file:
```svelte
<style>
  .scrim {
    background-color: rgba(8, 10, 14, 0.82);
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
  }
</style>
```

- [ ] **Step 8: Verify**

Run: `pnpm --filter @uniclip/web typecheck` (svelte-check) → clean. `pnpm --filter @uniclip/web test` → green (existing + device-name). Manually confirm the popover renders.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/lib/device-name.ts apps/web/src/lib/device-name.test.ts apps/web/src/components/roster-popover.svelte apps/web/src/routes/room.svelte apps/web/src/components/share-modal.svelte
git commit -m "feat(web): device naming + connected-device roster popover; Safari-safe share scrim

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: e2e — two devices see each other's names

**Files:**
- Create: `e2e/tests/presence.spec.ts`

- [ ] **Step 1: Write the test**

Create `e2e/tests/presence.spec.ts`, modeled on `two-browser.spec.ts` (UI room creation, two contexts). After both are in the room, open the roster on each and assert the other device appears. Default names depend on the browser; to keep the assertion stable, set explicit names via the rename UI first.

```ts
import { test, expect, chromium } from "@playwright/test";

test("two devices appear in each other's roster by name", async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const ctxB = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  await a.goto("/");
  await a.getByRole("button", { name: /Zero-knowledge/i }).click();
  await a.getByRole("button", { name: /Create encrypted room/i }).click();
  await expect(a).toHaveURL(/\/r\/[a-z2-9]{6}#/);
  const url = a.url();
  await b.goto(url);

  await expect(a.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });
  await expect(b.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });

  // Open the roster on A, rename to "Laptop".
  await a.getByRole("button", { name: /Connected devices/i }).click();
  await a.getByRole("button", { name: /Rename this device/i }).click();
  await a.getByRole("textbox", { name: /Your device name/i }).fill("Laptop");
  await a.getByRole("textbox", { name: /Your device name/i }).press("Enter");

  // Rename B to "Phone".
  await b.getByRole("button", { name: /Connected devices/i }).click();
  await b.getByRole("button", { name: /Rename this device/i }).click();
  await b.getByRole("textbox", { name: /Your device name/i }).fill("Phone");
  await b.getByRole("textbox", { name: /Your device name/i }).press("Enter");

  // Each sees the other's name in the roster.
  await expect(b.getByText("Laptop")).toBeVisible({ timeout: 10_000 });
  await expect(a.getByText("Phone")).toBeVisible({ timeout: 10_000 });

  await browser.close();
});
```

- [ ] **Step 2: Run the e2e**

Run: `pnpm test:e2e`
Expected: the new test passes alongside the existing 11 (12 total). If roster propagation is slightly slow, raise the timeouts before weakening assertions.

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/presence.spec.ts
git commit -m "test(e2e): two devices see each other's names in the roster

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] `pnpm typecheck` → clean.
- [ ] `pnpm test` → all unit suites green (protocol +2, relay +2, client-core +9, web +3).
- [ ] `pnpm test:e2e` → 12/12.
- [ ] Update `CLAUDE.md` `apps/web` / `client-core` bullets to mention the presence roster (fold into the Task 4 commit or a final `docs:` commit).

## Spec coverage check (self-review)

- §2 (per-tab id, per-origin editable name, `defaultDeviceName`) → Task 4 (room.svelte plumbing + device-name.ts). §3 (`PresenceFrameSchema`) → Task 1. §4 (AAD `presence:${routingId}`) → Task 3 (`PresenceManager.aad`). §5 (`PresenceManager` API + liveness) → Task 3 (presence.ts + tests). §6 (UniclipClient wiring, `presence` event, `setDeviceName`, `via` guard, lifecycle) → Task 3 Step 7. §7 (relay `signalLimiter` + forward-only) → Task 2. §8 (web roster popover + share-modal fold-in) → Task 4. §9 (security) → preserved by AAD + WS-only + no-persist + ephemeral id. §10 (tests) → Tasks 1–5.

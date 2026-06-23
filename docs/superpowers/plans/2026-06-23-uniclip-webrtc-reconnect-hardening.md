# WebRTC Reconnect Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WebRTC role assignment deterministic via a per-connection `from` identity handshake (the larger `from` is the sole initiator), so P2P (re)forms under any join/reconnect ordering — closing the P1 spec §10 double-reconnect limitation.

**Architecture:** Add one opaque `rtc-hello {from}` signaling frame. `PeerLink` drops its `role` constructor param: `start()` wires `ondatachannel` and announces `rtc-hello`; on receiving the peer's, the larger `from` creates the data channel and offers, the smaller waits. `UniclipClient` collapses `armPeer("initiator"|"responder")` into a single `armPeer()` and routes `rtc-hello` through the existing WS-only `via` guard. Crypto, transport seam, relay-fallback, and the Direct/Relayed badge are untouched.

**Tech Stack:** TypeScript, Zod (protocol), Bun + Hono (relay), WebRTC + WebCrypto (client-core), Vitest.

## Global Constraints

- **TDD always:** write the failing test, run it red, implement minimal, run it green, commit. (`CLAUDE.md` Conventions.)
- Packages are consumed as TS source (`main` → `src/index.ts`); no build step.
- **Relay tests run under Bun ≥ 1.3** (`pnpm --filter @uniclip/relay test <pattern>`); relay test JSON must be cast `(await res.json()) as {...}`.
- **client-core tests run in plain Node vitest** (no DOM) — inject a fake `RTCPeerConnection`; stub browser globals with `vi.stubGlobal`.
- **Security invariants (unchanged):** signaling is content-free, opaque to the relay, never buffered/tombstoned/persisted, and **WS-only in both directions** (the `via` guard drops it on the p2p pipe). `from` is a per-`PeerLink` random ULID with no cross-session meaning. App-layer AES-GCM stays on top of DTLS.
- **Determinism rule (the whole point):** initiator = the peer whose `from` is lexicographically **larger**; that peer alone calls `createDataChannel`. Politeness backstop: smaller `from` is polite (yields on glare).
- **Spec:** `docs/superpowers/specs/2026-06-23-uniclip-webrtc-reconnect-hardening-design.md`.
- **Commit style:** small, scoped (`feat(pkg): …`); end messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Branch: `feat/webrtc-reconnect-hardening`.

---

## File Structure

- `packages/protocol/src/index.ts` — add `RtcHelloSchema`; add to both `ClientFrameSchema` + `ServerFrameSchema`.
- `packages/protocol/src/index.test.ts` — accept/reject tests.
- `apps/relay/src/ws-handlers.ts` — route `rtc-hello` to `signalLimiter`.
- `apps/relay/test/signaling.test.ts` — extend: `rtc-hello` fans out, not replayed to a newcomer.
- `packages/client-core/src/peer-link.ts` — drop `role`; add `rtc-hello` to `PeerSignal`; identity handshake in `start()`/`handleSignal`.
- `packages/client-core/src/peer-link.test.ts` — rewrite for the identity handshake.
- `packages/client-core/src/client.ts` — `armPeer()` loses its param; presence arming simplified; `rtc-hello` added to the signaling `via` guard.
- `packages/client-core/src/client.test.ts` — update transport tests for the handshake; extend the `via`-guard test; add a reconnect re-announce test.

---

## Task 1: Protocol — `rtc-hello` identity frame

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/index.test.ts`

**Interfaces:**
- Produces: `RtcHelloSchema` (`{ type: "rtc-hello", from: string(≤64) }`), added to `ClientFrameSchema` and `ServerFrameSchema`.

- [ ] **Step 1: Write the failing test**

Append to `packages/protocol/src/index.test.ts`:

```ts
describe("rtc-hello identity frame", () => {
  const from = "01HF000000000000000000000A";
  it("accepts a valid rtc-hello on both unions", () => {
    expect(ClientFrameSchema.parse({ type: "rtc-hello", from })).toBeDefined();
    expect(ServerFrameSchema.parse({ type: "rtc-hello", from })).toBeDefined();
  });
  it("rejects a missing or oversized from, and extra keys", () => {
    expect(() => ClientFrameSchema.parse({ type: "rtc-hello" })).toThrow();
    expect(() => ClientFrameSchema.parse({ type: "rtc-hello", from: "x".repeat(65) })).toThrow();
    expect(() => ClientFrameSchema.parse({ type: "rtc-hello", from, extra: 1 })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uniclip/protocol test "rtc-hello"`
Expected: FAIL — `rtc-hello` not in the unions.

- [ ] **Step 3: Implement the schema**

In `packages/protocol/src/index.ts`, add after `IceFrameSchema`:

```ts
// WebRTC identity announce (reconnect hardening). Opaque to the relay (fanned
// out, never buffered). The larger `from` becomes the sole data-channel
// initiator, making role assignment deterministic across any reconnect order.
export const RtcHelloSchema = z
  .object({ type: z.literal("rtc-hello"), from: z.string().max(64) })
  .strict();
```

Add `RtcHelloSchema` to **both** discriminated unions (alongside `SdpFrameSchema`/`IceFrameSchema`):

```ts
export const ServerFrameSchema = z.discriminatedUnion("type", [
  // …existing entries…
  SdpFrameSchema,
  IceFrameSchema,
  RtcHelloSchema,
]);
```
```ts
export const ClientFrameSchema = z.discriminatedUnion("type", [
  // …existing entries…
  SdpFrameSchema,
  IceFrameSchema,
  RtcHelloSchema,
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @uniclip/protocol test "rtc-hello"` → PASS. Then `pnpm --filter @uniclip/protocol typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/index.ts packages/protocol/src/index.test.ts
git commit -m "feat(protocol): rtc-hello identity frame for deterministic P2P role

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Relay — route `rtc-hello` to the signaling rate budget

**Files:**
- Modify: `apps/relay/src/ws-handlers.ts`
- Test: `apps/relay/test/signaling.test.ts`

**Interfaces:**
- Consumes: `rtc-hello` is now a valid `ClientFrame` (Task 1), so `broadcast` already forwards it.
- Produces: `rtc-hello` billed to the existing `signalLimiter`; never buffered.

- [ ] **Step 1: Write the failing test**

Append to `apps/relay/test/signaling.test.ts` (reuse its existing `mintRoom`/`open` helpers):

```ts
it("fans out rtc-hello to the other peer and never replays it to a late joiner", async () => {
  const id = await mintRoom();
  const a = await open(`${baseWs}/ws/${id}`);
  const b = await open(`${baseWs}/ws/${id}`);
  await new Promise((r) => setTimeout(r, 30));
  a.ws.send(JSON.stringify({ type: "rtc-hello", from: "AAAA" }));
  await new Promise((r) => setTimeout(r, 30));
  expect(b.messages.some((m) => m.type === "rtc-hello" && m.from === "AAAA")).toBe(true);
  expect(a.messages.some((m) => m.type === "rtc-hello")).toBe(false); // not echoed to sender

  const c = await open(`${baseWs}/ws/${id}`);
  await new Promise((r) => setTimeout(r, 30));
  expect(c.messages.some((m) => m.type === "rtc-hello")).toBe(false); // not buffered/replayed
  a.ws.close(); b.ws.close(); c.ws.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uniclip/relay test signaling`
Expected: the fan-out part passes already (Task 1 made it a valid frame; `broadcast` forwards it), but to drive a real RED you must also assert the limiter routing. The genuinely new behavior is billing `rtc-hello` to `signalLimiter` — without the routing change it is billed to `frameLimiter` (the clip limiter, window 20). Add this RED-first test too:

```ts
it("bills rtc-hello to the signalLimiter, not the clip limiter", async () => {
  const id = await mintRoom();
  const a = await open(`${baseWs}/ws/${id}`);
  await open(`${baseWs}/ws/${id}`);
  await new Promise((r) => setTimeout(r, 20));
  let closed = false;
  a.ws.onclose = () => (closed = true);
  for (let i = 0; i < 60; i++) a.ws.send(JSON.stringify({ type: "rtc-hello", from: `p${i}` }));
  await new Promise((r) => setTimeout(r, 60));
  expect(closed).toBe(false); // 60 > clip limit (20) but < signal limit (200)
  a.ws.close();
});
```
This second test FAILS before the routing change (the socket is closed by `frameLimiter` at 20).

- [ ] **Step 3: Implement the routing**

In `apps/relay/src/ws-handlers.ts`, extend the limiter-selection ternary to include `rtc-hello`:

```ts
          const t = result.data.type;
          const limiter =
            t === "sdp" || t === "ice" || t === "rtc-hello" ? signalLimiter
            : t.startsWith("file-") ? chunkLimiter
            : frameLimiter;
```

No buffer-branch change: `rtc-hello` matches neither `"clip"` nor `"delete"`, so it is forwarded only.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @uniclip/relay test signaling` → PASS (all signaling tests). Then `pnpm --filter @uniclip/relay typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/ws-handlers.ts apps/relay/test/signaling.test.ts
git commit -m "feat(relay): bill rtc-hello to the signaling rate budget

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: client-core — identity handshake (PeerLink + UniclipClient)

> This is one task because dropping `PeerLink`'s `role` param breaks `UniclipClient`'s compile; they must change together to keep the build green.

**Files:**
- Modify: `packages/client-core/src/peer-link.ts`
- Modify: `packages/client-core/src/client.ts`
- Test: `packages/client-core/src/peer-link.test.ts` (rewrite), `packages/client-core/src/client.test.ts` (update)

**Interfaces:**
- Consumes: `DATACHANNEL_LABEL` (`./constants`), `RtcHelloSchema` shape (Task 1).
- Produces (PeerLink): `PeerSignal.type` becomes `"sdp" | "ice" | "rtc-hello"`; `PeerLinkOptions` **no longer has `role`**; `PeerRole` type removed. `start()` announces `rtc-hello` and creates no channel until role resolves; `handleSignal` resolves role on the first `rtc-hello`.
- Produces (UniclipClient): `armPeer()` takes no argument; `rtc-hello` joins the WS-only signaling guard in `handleFrame`.

- [ ] **Step 1: Rewrite the PeerLink tests (RED)**

Replace the contents of `packages/client-core/src/peer-link.test.ts` with the identity-handshake tests (the `FakePC`/`FakeChannel` fakes are unchanged from the existing file — keep them; only the role-based tests change):

```ts
import { describe, expect, it } from "vitest";
import { PeerLink, type PeerSignal } from "./peer-link";

class FakeChannel {
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  sent: string[] = [];
  send(d: string) { this.sent.push(d); }
  close() { this.readyState = "closed"; this.onclose?.(); }
  open() { this.readyState = "open"; this.onopen?.(); }
  deliver(d: string) { this.onmessage?.({ data: d }); }
}
class FakePC {
  static last: FakePC;
  signalingState = "stable";
  connectionState = "new";
  localDescription: { type: string; sdp: string } | null = null;
  onicecandidate: ((ev: { candidate: { toJSON(): unknown } | null }) => void) | null = null;
  ondatachannel: ((ev: { channel: FakeChannel }) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  channels: FakeChannel[] = [];
  added: unknown[] = [];
  constructor() { FakePC.last = this; }
  createDataChannel() { const c = new FakeChannel(); this.channels.push(c); return c; }
  async createOffer() { return { type: "offer", sdp: "OFFER" }; }
  async createAnswer() { return { type: "answer", sdp: "ANSWER" }; }
  async setLocalDescription(d: { type: string; sdp: string }) { this.localDescription = d; this.signalingState = d.type === "offer" ? "have-local-offer" : "stable"; }
  async setRemoteDescription(d: { type: string; sdp: string }) { this.signalingState = d.type === "offer" ? "have-remote-offer" : "stable"; }
  async addIceCandidate(c: unknown) { this.added.push(c); }
  close() { this.connectionState = "closed"; }
}
const mkPC = () => new FakePC() as unknown as RTCPeerConnection;
const MIN_FROM = "00000000000000000000000000"; // < any real ULID
const MAX_FROM = "ZZZZZZZZZZZZZZZZZZZZZZZZZZ"; // > any real ULID
function mk(extra: Partial<Record<"onOpen" | "onClose" | "onMessage", () => void>> = {}) {
  const out: PeerSignal[] = [];
  const link = new PeerLink({
    iceServers: [], signal: (s) => out.push(s),
    onOpen: extra.onOpen ?? (() => {}), onClose: extra.onClose ?? (() => {}),
    onMessage: (extra.onMessage as ((d: string) => void)) ?? (() => {}),
    createConnection: mkPC,
  });
  return { link, out };
}

it("start() announces rtc-hello and creates no channel or offer yet", () => {
  const { link, out } = mk();
  link.start();
  expect(out).toEqual([{ type: "rtc-hello", from: link.from }]);
  expect(FakePC.last.channels.length).toBe(0);
});

it("becomes the initiator (creates channel + offers) when its from is larger", async () => {
  const { link, out } = mk();
  link.start();
  await link.handleSignal({ type: "rtc-hello", from: MIN_FROM }); // peer smaller → we initiate
  expect(FakePC.last.channels.length).toBe(1);
  FakePC.last.onnegotiationneeded?.();
  await new Promise((r) => setTimeout(r, 0));
  expect(out.some((s) => s.type === "sdp" && s.description?.type === "offer")).toBe(true);
});

it("stays responder when its from is smaller; answers an inbound offer and opens via ondatachannel", async () => {
  let opened = false;
  const { link, out } = mk({ onOpen: () => (opened = true) });
  link.start();
  await link.handleSignal({ type: "rtc-hello", from: MAX_FROM }); // peer larger → we wait
  expect(FakePC.last.channels.length).toBe(0);
  await link.handleSignal({ type: "sdp", from: MAX_FROM, description: { type: "offer", sdp: "OFFER" } });
  expect(out.some((s) => s.type === "sdp" && s.description?.type === "answer")).toBe(true);
  const ch = new FakeChannel();
  FakePC.last.ondatachannel?.({ channel: ch });
  ch.open();
  expect(opened).toBe(true);
});

it("resolves role once — a second rtc-hello is ignored", async () => {
  const { link } = mk();
  link.start();
  await link.handleSignal({ type: "rtc-hello", from: MIN_FROM }); // initiator: 1 channel
  await link.handleSignal({ type: "rtc-hello", from: MAX_FROM }); // ignored
  expect(FakePC.last.channels.length).toBe(1);
});

it("forwards local ICE candidates and applies remote ones", async () => {
  const { link, out } = mk();
  link.start();
  FakePC.last.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "cand" }) } });
  expect(out.some((s) => s.type === "ice" && s.candidate === JSON.stringify({ candidate: "cand" }))).toBe(true);
  await link.handleSignal({ type: "ice", from: MIN_FROM, candidate: JSON.stringify({ candidate: "remote" }) });
  expect(FakePC.last.added).toContainEqual({ candidate: "remote" });
});

it("close() closes the connection and reports not open", () => {
  let closed = false;
  const { link } = mk({ onClose: () => (closed = true) });
  link.start();
  link.close();
  expect(link.isOpen()).toBe(false);
  expect(FakePC.last.connectionState).toBe("closed");
  expect(closed).toBe(true);
});
```

- [ ] **Step 2: Run the PeerLink tests to verify they fail**

Run: `pnpm --filter @uniclip/client-core test peer-link`
Expected: FAIL/compile error — `PeerLinkOptions` still requires `role`; `start()` still branches on role and doesn't announce `rtc-hello`.

- [ ] **Step 3: Implement the PeerLink identity handshake**

In `packages/client-core/src/peer-link.ts`:

(a) Remove the `PeerRole` type and add `rtc-hello` to `PeerSignal`; drop `role` from options:

```ts
export interface PeerSignal {
  type: "sdp" | "ice" | "rtc-hello";
  from: string;
  description?: { type: "offer" | "answer"; sdp: string };
  candidate?: string;
}

export interface PeerLinkOptions {
  iceServers: RTCIceServer[];
  signal: (s: PeerSignal) => void;
  onOpen: () => void;
  onClose: () => void;
  onMessage: (data: string) => void;
  createConnection?: (config: RTCConfiguration) => RTCPeerConnection;
}
```

(b) Update the class doc comment and add a `peerFrom` field:

```ts
// One RTCPeerConnection + one ordered/reliable RTCDataChannel, driven by the
// "perfect negotiation" pattern. The connection is injectable so the logic is
// unit-testable in Node (which has no RTCPeerConnection). Role is decided by an
// identity handshake: each peer announces its random per-connection `from` via
// an `rtc-hello`; the larger `from` is the sole initiator (creates the channel
// and offers). This is deterministic across any join/reconnect ordering.
export class PeerLink {
  readonly from = ulid();
  private readonly opts: PeerLinkOptions;
  private readonly make: (config: RTCConfiguration) => RTCPeerConnection;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private peerFrom: string | null = null;
  private makingOffer = false;
  private ignoreOffer = false;
  private closed = false;
```

(c) Replace `start()` (no role branch; always wire `ondatachannel`; announce identity):

```ts
  start(): void {
    const pc = this.make({ iceServers: this.opts.iceServers });
    this.pc = pc;
    pc.onicecandidate = ({ candidate }) =>
      this.opts.signal({
        type: "ice",
        from: this.from,
        candidate: candidate ? JSON.stringify(candidate.toJSON()) : "",
      });
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "failed" || s === "disconnected" || s === "closed") this.fireClose();
    };
    // Either peer may turn out to be the responder, so always be ready to
    // receive the channel. The channel is created only by the initiator, once
    // both `from` ids are known (see handleSignal "rtc-hello").
    pc.ondatachannel = (ev) => this.wireChannel(ev.channel);
    // Announce identity; the larger `from` becomes the sole initiator.
    this.opts.signal({ type: "rtc-hello", from: this.from });
  }
```

(d) Replace `handleSignal` (add the `rtc-hello` case; identity-based politeness backstop):

```ts
  async handleSignal(s: PeerSignal): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    if (s.type === "rtc-hello") {
      if (this.peerFrom !== null) return; // resolve role once
      this.peerFrom = s.from;
      if (this.from > s.from) {
        // Larger `from` = sole initiator: create the channel and offer.
        pc.onnegotiationneeded = () => void this.makeOffer();
        this.wireChannel(pc.createDataChannel(DATACHANNEL_LABEL, { ordered: true }));
      }
      // Smaller `from` = responder: wait for ondatachannel + the inbound offer.
      return;
    }
    try {
      if (s.type === "sdp" && s.description) {
        // Exactly one peer offers, so glare should not occur; keep an
        // identity-based backstop — the smaller `from` is polite (yields).
        const polite = this.peerFrom !== null ? this.from < this.peerFrom : true;
        const collision =
          s.description.type === "offer" && (this.makingOffer || pc.signalingState !== "stable");
        this.ignoreOffer = !polite && collision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription({ type: s.description.type, sdp: s.description.sdp });
        if (s.description.type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.opts.signal({
            type: "sdp",
            from: this.from,
            description: { type: "answer", sdp: pc.localDescription?.sdp ?? answer.sdp ?? "" },
          });
        }
      } else if (s.type === "ice" && s.candidate !== undefined) {
        if (s.candidate === "") return; // end-of-candidates marker
        await pc.addIceCandidate(JSON.parse(s.candidate) as RTCIceCandidateInit);
      }
    } catch {
      // A failed addIceCandidate after an ignored offer is expected; swallow.
    }
  }
```

(`makeOffer`, `wireChannel`, `send`, `fireClose`, `close` are unchanged.)

- [ ] **Step 4: Update the UniclipClient tests (RED before the client.ts change)**

In `packages/client-core/src/client.test.ts`:

First, **remove the unused `import { PeerLink } from "./peer-link";`** line if present (vestigial). Then update the transport-seam tests so P2P opens via the identity handshake. The key change: after presence reaches 2, deliver an inbound `rtc-hello` with `from: "00000000000000000000000000"` (smaller than the client's random `from`) so the client's `PeerLink` becomes the initiator and the fake channel opens. The existing `fakePcFactory` (channel opens via `queueMicrotask` on `createDataChannel`) already supports this; ensure it also exposes `ondatachannel` and `onnegotiationneeded` settable fields (it does — they are plain nullable props). Replace the three transport tests with:

```ts
const MIN_FROM = "00000000000000000000000000";

describe("UniclipClient transport seam", () => {
  it("opens P2P via the identity handshake and sends a clip over the channel (not the WS)", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app", iceServers: [], createConnection: fakePcFactory(),
    });
    const transports: string[] = [];
    client.on("transport", (v: string) => transports.push(v));
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    // client armed → it announced rtc-hello over the WS:
    expect(ws.sent.some((p) => JSON.parse(p).type === "rtc-hello")).toBe(true);
    // peer announces a smaller from → client becomes initiator → channel opens:
    ws.emit({ type: "rtc-hello", from: MIN_FROM });
    await waitFor(() => transports.includes("p2p"));
    const before = ws.sent.length;
    await client.send("over p2p");
    expect(ws.sent.length).toBe(before); // clip went over the data channel, not the WS
  });

  it("falls back to relay transport when the peer leaves", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app", iceServers: [], createConnection: fakePcFactory(),
    });
    const transports: string[] = [];
    client.on("transport", (v: string) => transports.push(v));
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    ws.emit({ type: "rtc-hello", from: MIN_FROM });
    await waitFor(() => transports.includes("p2p"));
    ws.emit({ type: "peer-left", peerCount: 1 });
    await waitFor(() => transports.at(-1) === "relay");
    await client.send("after p2p");
    expect(JSON.parse(ws.sent.at(-1)!).type).toBe("clip"); // back on the WS
  });

  it("drops signaling (sdp/ice/rtc-hello) arriving over the p2p pipe; does not surface as content", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app", iceServers: [], createConnection: fakePcFactory(),
    });
    let clips = 0;
    client.on("clip", () => clips++);
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    ws.emit({ type: "ice", from: "peer", candidate: "" });
    ws.emit({ type: "rtc-hello", from: MIN_FROM });
    await new Promise((r) => setTimeout(r, 10));
    expect(clips).toBe(0); // signaling never surfaces as content
  });

  it("re-announces its identity on reconnect (re-arm)", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app", iceServers: [], createConnection: fakePcFactory(),
    });
    await client.connect();
    const ws1 = MockWebSocket.instances.at(-1)!;
    ws1.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    expect(ws1.sent.filter((p) => JSON.parse(p).type === "rtc-hello").length).toBe(1);
    ws1.close(); // triggers reconnect → new socket
    await waitFor(() => MockWebSocket.instances.length >= 2);
    const ws2 = MockWebSocket.instances.at(-1)!;
    ws2.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    expect(ws2.sent.some((p) => JSON.parse(p).type === "rtc-hello")).toBe(true); // re-announced
  });
});
```

> Note on the existing `fakePcFactory`: it returns a fake `RTCPeerConnection` whose `createDataChannel()` returns a channel that fires `onopen` via `queueMicrotask`. With the new handshake, `createDataChannel` is only called once the client receives the peer's `rtc-hello` (smaller `from`), so the channel opens then. No change to `fakePcFactory` is required; if its object literal lacks settable `ondatachannel` / `onnegotiationneeded` fields, add them as `null` initialized props (the client assigns to them).

- [ ] **Step 5: Run the client tests to verify they fail**

Run: `pnpm --filter @uniclip/client-core test client`
Expected: FAIL/compile error — `armPeer` still takes a `role` arg and `handleFrame` does not route `rtc-hello`.

- [ ] **Step 6: Implement the UniclipClient changes**

In `packages/client-core/src/client.ts`:

(a) Drop `PeerRole` from the import:

```ts
import { PeerLink, type PeerSignal } from "./peer-link";
```

(b) `armPeer()` loses its parameter and the `role` option:

```ts
  private armPeer(): void {
    this.peer?.close();
    this.peer = new PeerLink({
      iceServers: this.iceServers,
      ...(this.createConnection ? { createConnection: this.createConnection } : {}),
      signal: (s: PeerSignal) => {
        // Signaling ALWAYS rides the WS — never the channel it is establishing.
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(s));
      },
      onOpen: () => this.setTransport("p2p"),
      onMessage: (data) => void this.handleFrame(data, "p2p").catch(() => undefined),
      onClose: () => {
        this.setTransport("relay");
        this.transfers.abortAll("disconnected"); // live-only transfers cannot survive a channel drop
      },
    });
    this.peer.start();
  }
```

(c) Simplify presence arming (role is no longer event-derived):

```ts
      case "hello":
        this.emit({ kind: "status", value: "connected" });
        this.emit({ kind: "peer", count: frame.peerCount });
        this.emit({ kind: "room", backfill: frame.backfill, ephemeral: frame.ephemeral });
        this.flushQueue();
        // Arm a PeerLink; the rtc-hello identity handshake decides who initiates.
        if (frame.peerCount >= 2) this.armPeer();
        return;
      case "peer-joined":
        this.emit({ kind: "peer", count: frame.peerCount });
        if (frame.peerCount >= 2 && !this.peer) this.armPeer();
        return;
```

(d) Add `rtc-hello` to the WS-only signaling guard:

```ts
      case "sdp":
      case "ice":
      case "rtc-hello":
        if (via !== "ws") return;
        await this.peer?.handleSignal(frame as PeerSignal);
        return;
```

- [ ] **Step 7: Run the full client-core suite to verify green**

Run: `pnpm --filter @uniclip/client-core test`
Expected: PASS — peer-link (6) + client (existing + updated transport/reconnect) + the rest. Then `pnpm --filter @uniclip/client-core typecheck` → clean.

- [ ] **Step 8: Commit**

```bash
git add packages/client-core/src/peer-link.ts packages/client-core/src/client.ts packages/client-core/src/peer-link.test.ts packages/client-core/src/client.test.ts
git commit -m "feat(client-core): deterministic P2P role via rtc-hello identity handshake

Drops PeerLink's role param; start() announces rtc-hello and the larger from
becomes the sole data-channel initiator. UniclipClient collapses armPeer to a
single call and routes rtc-hello through the WS-only signaling guard. Closes
the P1 §10 double-reconnect limitation.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] `pnpm typecheck` → clean across all packages.
- [ ] `pnpm test` → all unit suites green (protocol gains 2 tests; relay gains 2; client-core peer-link rewritten + client transport/reconnect updated).
- [ ] `pnpm test:e2e` → 11/11 — the existing Direct/Relayed e2e tests must still pass unchanged (they exercise the full handshake end-to-end in Chromium).
- [ ] Update the P1 spec §6/§10 "Known limitation / Deferred follow-up" to mark the reconnect hardening **done** (point at this spec/plan) — fold into the Task 3 commit or a final `docs:` commit.

## Spec coverage check (self-review)

- Spec §2 (`RtcHelloSchema`, both unions) → Task 1. §3 (relay `signalLimiter` routing, no buffering) → Task 2. §4 (PeerLink: drop `role`, `peerFrom`, `start()` announces, `handleSignal` resolves role + politeness backstop) → Task 3 Step 3. §4.2 (synchronous-arm ordering) → preserved (armPeer calls start() synchronously in the presence handler). §5 (UniclipClient: `armPeer()` no arg, presence arming, `rtc-hello` in the `via` guard) → Task 3 Step 6. §6 (handshake data flow) → Tasks 1+3. §7 (test matrix) → Tasks 1–3 + e2e unchanged. §8 (mixed-version degrades to relay) → preserved by the old-relay/no-rtc-hello fallback (no `rtc-hello` → role never resolves → stays relay).

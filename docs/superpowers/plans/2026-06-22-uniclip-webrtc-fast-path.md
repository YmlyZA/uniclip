# WebRTC Fast Path (P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a peer-to-peer `RTCDataChannel` that carries uniclip's existing encrypted frames (LAN-direct when peers can reach each other), with the relay demoted to signaling + presence + content fallback — purely additive, so a peer that never establishes P2P behaves exactly as today.

**Architecture:** A transport seam in `client-core` (`sendFrame()` prefers an open data channel, falls back to the WebSocket). One injectable `PeerLink` module wraps `RTCPeerConnection` and runs perfect negotiation; its SDP/ICE ride the WS via two new opaque `protocol` frames the relay fans out (never buffers). The app-layer AES-256-GCM envelope is unchanged and sits on top of WebRTC's DTLS, so content is opaque on every path.

**Tech Stack:** TypeScript, Zod (protocol), Bun + Hono (relay), WebCrypto + WebRTC (client-core), Svelte 5 (web), Vitest, Playwright.

## Global Constraints

- **TDD always:** write the failing test, run it red, implement minimal, run it green, commit. (`CLAUDE.md` Conventions.)
- **Packages are consumed as TS source** (`main` → `src/index.ts`); never rely on a build step. Library `tsc` must not emit into `src/`.
- **Relay tests run under Bun ≥ 1.3** (`bun --bun vitest run`); relay test JSON must be cast: `(await res.json()) as {...}`. New CJS/ESM deps that come back undefined go in `apps/relay/vitest.config.ts` `server.deps.inline`.
- **`apps/web` / `client-core` tests run in Node vitest** — no DOM. Stub browser globals with `vi.stubGlobal`, never `Object.assign(globalThis, …)`. Node has no `RTCPeerConnection`; inject a fake.
- **WebCrypto-feeding helpers return `Uint8Array<ArrayBuffer>`** (TS 5.7 `BufferSource`).
- **Security invariants (do not break):** Mode-A zero-knowledge (only `routingId` + opaque frames reach the relay); app-layer AES-GCM stays on top of DTLS; relay persists no content; signaling frames are never buffered/tombstoned/persisted. AAD scheme unchanged.
- **Spec:** `docs/superpowers/specs/2026-06-22-uniclip-webrtc-fast-path-design.md`.
- **Commit style:** small, scoped (`feat(pkg): …` / `test(pkg): …`). End commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Work on branch `feat/webrtc-fast-path`.

---

## File Structure

- `packages/protocol/src/index.ts` — add `ICE_SERVERS`, `SdpFrameSchema`, `IceFrameSchema`; add both to `ClientFrameSchema` + `ServerFrameSchema`.
- `packages/protocol/src/index.test.ts` — accept/reject tests for the two frames.
- `apps/relay/src/ws-handlers.ts` — add `signalLimiter`, route `sdp`/`ice` to it; existing `broadcast` already forwards them (verify they are not buffered).
- `apps/relay/test/signaling.test.ts` (new) — fan-out + not-replayed-to-newcomer + rate-limit.
- `packages/client-core/src/peer-link.ts` (new) — `PeerLink` class (injectable `RTCPeerConnection`, perfect negotiation).
- `packages/client-core/src/peer-link.test.ts` (new) — negotiation, open/message/close, ICE, glare.
- `packages/client-core/src/client.ts` — `sendFrame` seam, route `sdp`/`ice` into `PeerLink`, arm/teardown by presence, `transport` event, abort transfers on channel close.
- `packages/client-core/src/client.test.ts` — seam + transport-event tests (fake `PeerLink` connection via injected factory).
- `apps/web/src/routes/room.svelte` — subscribe to `transport`, render a `data-testid="transport"` badge.
- `e2e/tests/webrtc.spec.ts` (new) — two-context P2P assertion + relay-only regression.

---

## Task 1: Protocol — `sdp` / `ice` signaling frames

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/index.test.ts`

**Interfaces:**
- Produces: `SdpFrameSchema`, `IceFrameSchema`, `ICE_SERVERS: RTCIceServer[]`; both schemas added to `ClientFrameSchema` and `ServerFrameSchema`. Wire shapes:
  - `{ type: "sdp", from: string(≤64), description: { type: "offer"|"answer", sdp: string(≤16384) } }`
  - `{ type: "ice", from: string(≤64), candidate: string(≤4096) }` — `candidate` is `JSON.stringify(RTCIceCandidateInit)`, or `""` for end-of-candidates.

- [ ] **Step 1: Write the failing test**

Add to `packages/protocol/src/index.test.ts`:

```ts
describe("signaling frames", () => {
  const from = "01HF000000000000000000000A";
  it("accepts a valid sdp offer", () => {
    expect(
      ClientFrameSchema.parse({
        type: "sdp", from,
        description: { type: "offer", sdp: "v=0\r\n..." },
      }),
    ).toBeDefined();
  });
  it("accepts an ice candidate and an end-of-candidates marker", () => {
    expect(ClientFrameSchema.parse({ type: "ice", from, candidate: '{"candidate":"x"}' })).toBeDefined();
    expect(ClientFrameSchema.parse({ type: "ice", from, candidate: "" })).toBeDefined();
  });
  it("rejects a bad sdp description type", () => {
    expect(() =>
      ClientFrameSchema.parse({ type: "sdp", from, description: { type: "nope", sdp: "x" } }),
    ).toThrow();
  });
  it("rejects an oversized sdp", () => {
    expect(() =>
      ClientFrameSchema.parse({ type: "sdp", from, description: { type: "offer", sdp: "x".repeat(16385) } }),
    ).toThrow();
  });
  it("forwards both shapes as server frames too", () => {
    expect(ServerFrameSchema.parse({ type: "ice", from, candidate: "" })).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uniclip/protocol test signaling`
Expected: FAIL — `sdp`/`ice` are not members of the unions yet.

- [ ] **Step 3: Implement the schemas**

In `packages/protocol/src/index.ts`, after `IceFrameSchema` would naturally sit (after the file frames, before `HelloFrameSchema`), add:

```ts
// WebRTC signaling (Phase 3 v0.3). Opaque to the relay — fanned out, never
// buffered. `from` is a per-connection random peer id for perfect-negotiation
// politeness; the relay neither assigns nor validates it. `candidate` is a
// JSON-serialized RTCIceCandidateInit, or "" for end-of-candidates.
export const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export const SdpFrameSchema = z
  .object({
    type: z.literal("sdp"),
    from: z.string().max(64),
    description: z
      .object({ type: z.enum(["offer", "answer"]), sdp: z.string().max(16 * 1024) })
      .strict(),
  })
  .strict();

export const IceFrameSchema = z
  .object({
    type: z.literal("ice"),
    from: z.string().max(64),
    candidate: z.string().max(4096),
  })
  .strict();
```

Then add both to **both** unions:

```ts
export const ServerFrameSchema = z.discriminatedUnion("type", [
  HelloFrameSchema,
  PeerJoinedFrameSchema,
  PeerLeftFrameSchema,
  ClipboardFrameSchema,
  DeleteFrameSchema,
  ErrorFrameSchema,
  FileOfferSchema,
  FileAcceptSchema,
  FileDeclineSchema,
  FileChunkSchema,
  FileAckSchema,
  FileCompleteSchema,
  FileCancelSchema,
  SdpFrameSchema,
  IceFrameSchema,
]);
```

```ts
export const ClientFrameSchema = z.discriminatedUnion("type", [
  ClipboardFrameSchema,
  DeleteFrameSchema,
  FileOfferSchema,
  FileAcceptSchema,
  FileDeclineSchema,
  FileChunkSchema,
  FileAckSchema,
  FileCompleteSchema,
  FileCancelSchema,
  SdpFrameSchema,
  IceFrameSchema,
]);
```

> Note: `RTCIceServer` is a DOM lib type. `packages/protocol` is consumed by the browser app; confirm its `tsconfig` has `"lib"` including `"DOM"` (it does — the package already references browser types via the workspace). If `tsc` flags `RTCIceServer`, type `ICE_SERVERS` as `{ urls: string }[]` instead — structurally identical for our use.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @uniclip/protocol test signaling`
Expected: PASS. Then `pnpm --filter @uniclip/protocol typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/index.ts packages/protocol/src/index.test.ts
git commit -m "feat(protocol): sdp/ice signaling frames + ICE_SERVERS

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Relay — fan out signaling, never buffer it

**Files:**
- Modify: `apps/relay/src/ws-handlers.ts`
- Test: `apps/relay/test/signaling.test.ts` (new)

**Interfaces:**
- Consumes: `SdpFrameSchema`/`IceFrameSchema` are now valid `ClientFrame`s (Task 1), so `ClientFrameSchema.safeParse` accepts them and the existing `broadcast(room.sockets, raw, result.data)` already forwards them.
- Produces: a `signalLimiter` rate bucket; signaling is forwarded but never `pushRecent`/`addTombstone`/persisted.

- [ ] **Step 1: Write the failing test**

Create `apps/relay/test/signaling.test.ts` (mirror the harness in `apps/relay/test/ws.test.ts`):

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { RoomStore } from "../src/rooms";
import { attachWebSocket } from "../src/ws-handlers";

let server: ReturnType<typeof Bun.serve> | null = null;
let baseHttp = "";
let baseWs = "";

beforeEach(() => {
  const store = new RoomStore();
  const app = buildApp({ roomCount: () => store.count, store });
  const { websocket, fetch } = attachWebSocket(app, store);
  server = Bun.serve({ port: 0, fetch, websocket });
  baseHttp = `http://localhost:${server.port}`;
  baseWs = `ws://localhost:${server.port}`;
});
afterEach(() => { server?.stop(true); server = null; });

async function mintRoom(): Promise<string> {
  const res = await fetch(`${baseHttp}/api/room`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "A" }),
  });
  return ((await res.json()) as { roomId: string }).roomId;
}
function open(url: string): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: any[] = [];
    ws.onmessage = (e) => messages.push(JSON.parse(e.data as string));
    ws.onopen = () => resolve({ ws, messages });
    ws.onerror = reject;
  });
}

describe("signaling fan-out", () => {
  it("forwards an sdp frame to the OTHER peer only, and never to a later joiner", async () => {
    const id = await mintRoom();
    const a = await open(`${baseWs}/ws/${id}`);
    const b = await open(`${baseWs}/ws/${id}`);
    await new Promise((r) => setTimeout(r, 30));
    a.ws.send(JSON.stringify({ type: "sdp", from: "A", description: { type: "offer", sdp: "v=0" } }));
    await new Promise((r) => setTimeout(r, 30));
    expect(b.messages.some((m) => m.type === "sdp" && m.description?.sdp === "v=0")).toBe(true);
    expect(a.messages.some((m) => m.type === "sdp")).toBe(false); // not echoed to sender

    // A late joiner must NOT receive the earlier signaling (it is not buffered).
    const c = await open(`${baseWs}/ws/${id}`);
    await new Promise((r) => setTimeout(r, 30));
    expect(c.messages.some((m) => m.type === "sdp")).toBe(false);
    a.ws.close(); b.ws.close(); c.ws.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uniclip/relay test signaling`
Expected: FAIL — before the limiter routing change, `sdp` is billed to the wrong limiter but would still forward; the test should still pass on fan-out, so to make it RED first, run it BEFORE Task 1 is merged OR assert the limiter. Since Task 1 is already merged, this test will likely PASS on fan-out already. That is expected — the real new code in this task is the limiter. Proceed: add the limiter assertion below in Step 3's companion test, which fails until the limiter exists.

> Right-sizing note: fan-out works for free once Task 1 lands. The deliverable of Task 2 is the dedicated `signalLimiter` so ICE trickle does not trip the `(20,10_000)` clip limiter. Add a second test that drives >20 `ice` frames rapidly and asserts the socket is NOT closed:

```ts
it("does not trip the clip limiter under ICE trickle (uses signalLimiter)", async () => {
  const id = await mintRoom();
  const a = await open(`${baseWs}/ws/${id}`);
  await open(`${baseWs}/ws/${id}`);
  await new Promise((r) => setTimeout(r, 20));
  let closed = false;
  a.ws.onclose = () => (closed = true);
  for (let i = 0; i < 60; i++) a.ws.send(JSON.stringify({ type: "ice", from: "A", candidate: `c${i}` }));
  await new Promise((r) => setTimeout(r, 60));
  expect(closed).toBe(false); // 60 ICE frames > clip limit (20) but < signal limit (200)
  a.ws.close();
});
```

Run: `pnpm --filter @uniclip/relay test signaling`
Expected: the trickle test FAILS (socket closed by the shared `frameLimiter` at 20).

- [ ] **Step 3: Implement the limiter routing**

In `apps/relay/src/ws-handlers.ts`, add the limiter near `frameLimiter`/`chunkLimiter`:

```ts
  // sdp/ice signaling is bursty (ICE trickle) but bounded; give it its own
  // budget so it never trips the clip limiter, and never bill it to the file
  // limiter either.
  const signalLimiter = new SlidingWindowLimiter(200, 10_000);
```

Replace the limiter-selection line:

```ts
          const limiter = result.data.type.startsWith("file-") ? chunkLimiter : frameLimiter;
```

with:

```ts
          const t = result.data.type;
          const limiter =
            t === "sdp" || t === "ice" ? signalLimiter : t.startsWith("file-") ? chunkLimiter : frameLimiter;
```

No change is needed to the buffer branch: it only matches `"clip"` / `"delete"`, so `sdp`/`ice` are forwarded by the existing `broadcast` and never buffered. Optionally update the trailing comment to mention signaling is forward-only too.

Export `signalLimiter` from the return object for symmetry with the others:

```ts
  return { websocket, fetch: app.fetch, frameLimiter, chunkLimiter, signalLimiter };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @uniclip/relay test signaling`
Expected: PASS (both fan-out and trickle). Then `pnpm --filter @uniclip/relay typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/ws-handlers.ts apps/relay/test/signaling.test.ts
git commit -m "feat(relay): fan out sdp/ice signaling with a dedicated rate budget

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: client-core — `PeerLink` (injectable WebRTC, perfect negotiation)

**Files:**
- Create: `packages/client-core/src/peer-link.ts`
- Test: `packages/client-core/src/peer-link.test.ts`

**Interfaces:**
- Consumes: `ICE_SERVERS` from `@uniclip/protocol`; `ulid` from `ulid`.
- Produces:
  ```ts
  export type PeerRole = "initiator" | "responder";
  export interface PeerSignal {
    type: "sdp" | "ice";
    from: string;
    description?: { type: "offer" | "answer"; sdp: string };
    candidate?: string;
  }
  export interface PeerLinkOptions {
    role: PeerRole;
    iceServers: RTCIceServer[];
    signal: (s: PeerSignal) => void;      // send over the WS (NOT the channel)
    onOpen: () => void;
    onClose: () => void;
    onMessage: (data: string) => void;
    createConnection?: (config: RTCConfiguration) => RTCPeerConnection; // default: new RTCPeerConnection
  }
  export class PeerLink {
    readonly from: string;
    constructor(opts: PeerLinkOptions);
    start(): void;
    handleSignal(s: PeerSignal): Promise<void>;
    send(data: string): boolean;          // true if the channel is open and accepted it
    isOpen(): boolean;
    close(): void;
  }
  ```
- Role is decided by the caller from join order: a **newcomer** (its own `hello` shows `peerCount >= 2`) is the `responder` (polite); an **existing** peer (it receives `peer-joined`) is the `initiator` (impolite). The `from` lexicographic tiebreak is the glare safety net for the rare simultaneous-join race.

- [ ] **Step 1: Write the failing test**

Create `packages/client-core/src/peer-link.test.ts`. The fake implements only the subset `PeerLink` calls; it is cast to `RTCPeerConnection`.

```ts
import { describe, expect, it, vi } from "vitest";
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

it("initiator creates a channel, offers, and opens on answer + channel.open", async () => {
  const out: PeerSignal[] = [];
  let opened = false;
  const link = new PeerLink({
    role: "initiator", iceServers: [],
    signal: (s) => out.push(s), onOpen: () => (opened = true),
    onClose: () => {}, onMessage: () => {}, createConnection: mkPC,
  });
  link.start();
  FakePC.last.onnegotiationneeded?.();
  await new Promise((r) => setTimeout(r, 0));
  expect(out.some((s) => s.type === "sdp" && s.description?.type === "offer")).toBe(true);
  await link.handleSignal({ type: "sdp", from: "peer", description: { type: "answer", sdp: "ANSWER" } });
  FakePC.last.channels[0]!.open();
  expect(opened).toBe(true);
  expect(link.isOpen()).toBe(true);
});

it("responder answers an incoming offer and surfaces channel messages", async () => {
  const out: PeerSignal[] = [];
  const got: string[] = [];
  const link = new PeerLink({
    role: "responder", iceServers: [],
    signal: (s) => out.push(s), onOpen: () => {},
    onClose: () => {}, onMessage: (d) => got.push(d), createConnection: mkPC,
  });
  link.start();
  await link.handleSignal({ type: "sdp", from: "peer", description: { type: "offer", sdp: "OFFER" } });
  expect(out.some((s) => s.type === "sdp" && s.description?.type === "answer")).toBe(true);
  const ch = new FakeChannel();
  FakePC.last.ondatachannel?.({ channel: ch });
  ch.open();
  ch.deliver("hi");
  expect(got).toEqual(["hi"]);
});

it("forwards local ICE candidates and applies remote ones", async () => {
  const out: PeerSignal[] = [];
  const link = new PeerLink({
    role: "initiator", iceServers: [], signal: (s) => out.push(s),
    onOpen: () => {}, onClose: () => {}, onMessage: () => {}, createConnection: mkPC,
  });
  link.start();
  FakePC.last.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "cand" }) } });
  expect(out.some((s) => s.type === "ice" && s.candidate === JSON.stringify({ candidate: "cand" }))).toBe(true);
  FakePC.last.onicecandidate?.({ candidate: null }); // end-of-candidates
  expect(out.some((s) => s.type === "ice" && s.candidate === "")).toBe(true);
  await link.handleSignal({ type: "ice", from: "peer", candidate: JSON.stringify({ candidate: "remote" }) });
  expect(FakePC.last.added).toContainEqual({ candidate: "remote" });
});

it("a polite responder ignores nothing; an impolite initiator ignores a glare offer", async () => {
  const link = new PeerLink({
    role: "initiator", iceServers: [], signal: () => {},
    onOpen: () => {}, onClose: () => {}, onMessage: () => {}, createConnection: mkPC,
  });
  link.start();
  FakePC.last.signalingState = "have-local-offer"; // we are mid-offer → collision
  const before = FakePC.last.signalingState;
  await link.handleSignal({ type: "sdp", from: "peer", description: { type: "offer", sdp: "OFFER" } });
  expect(FakePC.last.signalingState).toBe(before); // impolite: offer ignored, state untouched
});

it("close() closes the connection and reports not open", () => {
  let closed = false;
  const link = new PeerLink({
    role: "initiator", iceServers: [], signal: () => {},
    onOpen: () => {}, onClose: () => (closed = true), onMessage: () => {}, createConnection: mkPC,
  });
  link.start();
  link.close();
  expect(link.isOpen()).toBe(false);
  expect(FakePC.last.connectionState).toBe("closed");
  expect(closed).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uniclip/client-core test peer-link`
Expected: FAIL — `./peer-link` does not exist.

- [ ] **Step 3: Implement `PeerLink`**

Create `packages/client-core/src/peer-link.ts`:

```ts
import { ulid } from "ulid";
import { DATACHANNEL_LABEL } from "./constants";

export type PeerRole = "initiator" | "responder";

export interface PeerSignal {
  type: "sdp" | "ice";
  from: string;
  description?: { type: "offer" | "answer"; sdp: string };
  candidate?: string;
}

export interface PeerLinkOptions {
  role: PeerRole;
  iceServers: RTCIceServer[];
  signal: (s: PeerSignal) => void;
  onOpen: () => void;
  onClose: () => void;
  onMessage: (data: string) => void;
  createConnection?: (config: RTCConfiguration) => RTCPeerConnection;
}

// One RTCPeerConnection + one ordered/reliable RTCDataChannel, driven by the
// "perfect negotiation" pattern. The connection is injectable so the logic is
// unit-testable in Node (which has no RTCPeerConnection). Politeness is primary
// by role (responder = polite), with `from` as a glare tiebreak.
export class PeerLink {
  readonly from = ulid();
  private readonly opts: PeerLinkOptions;
  private readonly make: (config: RTCConfiguration) => RTCPeerConnection;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private makingOffer = false;
  private ignoreOffer = false;
  private closed = false;

  constructor(opts: PeerLinkOptions) {
    this.opts = opts;
    this.make = opts.createConnection ?? ((c) => new RTCPeerConnection(c));
  }

  isOpen(): boolean {
    return this.channel?.readyState === "open";
  }

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
    if (this.opts.role === "initiator") {
      pc.onnegotiationneeded = () => void this.makeOffer();
      this.wireChannel(pc.createDataChannel(DATACHANNEL_LABEL, { ordered: true }));
    } else {
      pc.ondatachannel = (ev) => this.wireChannel(ev.channel);
    }
  }

  private async makeOffer(): Promise<void> {
    if (!this.pc) return;
    try {
      this.makingOffer = true;
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.opts.signal({
        type: "sdp",
        from: this.from,
        description: { type: "offer", sdp: this.pc.localDescription?.sdp ?? offer.sdp ?? "" },
      });
    } catch {
      /* renegotiation will be retried on the next negotiationneeded */
    } finally {
      this.makingOffer = false;
    }
  }

  async handleSignal(s: PeerSignal): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      if (s.type === "sdp" && s.description) {
        const polite = this.opts.role === "responder" || this.from < s.from;
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

  private wireChannel(ch: RTCDataChannel): void {
    this.channel = ch;
    ch.onopen = () => this.opts.onOpen();
    ch.onclose = () => this.fireClose();
    ch.onmessage = (ev: MessageEvent) => this.opts.onMessage(ev.data as string);
  }

  send(data: string): boolean {
    if (this.channel?.readyState !== "open") return false;
    this.channel.send(data);
    return true;
  }

  private fireClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.opts.onClose();
  }

  close(): void {
    try {
      this.channel?.close();
    } catch { /* already gone */ }
    try {
      this.pc?.close();
    } catch { /* already gone */ }
    this.fireClose();
  }
}
```

Create `packages/client-core/src/constants.ts`:

```ts
// Single in-band data channel label shared by both peers.
export const DATACHANNEL_LABEL = "uniclip";
// If P2P has not opened within this window of a peer being present, stay on the
// relay (no error). A later peer-join re-arms the attempt.
export const P2P_CONNECT_TIMEOUT_MS = 8_000;
```

> The fake's `send`/`createOffer` etc. are a strict subset of `RTCPeerConnection`; the `as unknown as RTCPeerConnection` cast in the test is the sanctioned injection pattern (mirrors `FileTransferManager`). `MessageEvent` exists in the client-core DOM lib; the fake passes `{ data }` which satisfies the `.data` access.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @uniclip/client-core test peer-link`
Expected: PASS (5 tests). Then `pnpm --filter @uniclip/client-core typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/client-core/src/peer-link.ts packages/client-core/src/constants.ts packages/client-core/src/peer-link.test.ts
git commit -m "feat(client-core): PeerLink — injectable WebRTC data channel with perfect negotiation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: client-core — transport seam in `UniclipClient`

**Files:**
- Modify: `packages/client-core/src/client.ts`
- Test: `packages/client-core/src/client.test.ts`

**Interfaces:**
- Consumes: `PeerLink`, `PeerSignal`, `PeerRole` (Task 3); `ICE_SERVERS` (Task 1).
- Produces: a `sendFrame(frame: ClientFrame): boolean` method; a new client event `{ kind: "transport"; value: "p2p" | "relay" }` and handler `transport: (value: "p2p" | "relay") => void`; an optional `iceServers?: RTCIceServer[]` and `createConnection?` on `UniclipClientOptions` for tests/self-host.

- [ ] **Step 1: Write the failing test**

Add to `packages/client-core/src/client.test.ts`. Extend the existing `MockWebSocket` usage; inject a fake peer connection via the new option. Append:

```ts
import { PeerLink } from "./peer-link"; // (top of file with the other imports)

// A fake RTCPeerConnection sufficient for UniclipClient wiring tests: it opens
// its data channel synchronously so we can assert the transport switch.
function fakePcFactory() {
  return () =>
    ({
      _ch: null as any,
      signalingState: "stable",
      connectionState: "new",
      localDescription: { type: "offer", sdp: "X" },
      onicecandidate: null,
      ondatachannel: null,
      onnegotiationneeded: null,
      onconnectionstatechange: null,
      createDataChannel() {
        const ch: any = { readyState: "open", send: vi.fn(), close() { this.readyState = "closed"; this.onclose?.(); }, onopen: null, onclose: null, onmessage: null };
        this._ch = ch;
        queueMicrotask(() => ch.onopen?.());
        return ch;
      },
      async createOffer() { return { type: "offer", sdp: "X" }; },
      async createAnswer() { return { type: "answer", sdp: "Y" }; },
      async setLocalDescription() {},
      async setRemoteDescription() {},
      async addIceCandidate() {},
      close() { this.connectionState = "closed"; this.onconnectionstatechange?.(); },
    }) as unknown as RTCPeerConnection;
}

describe("UniclipClient transport seam", () => {
  it("sends a clip over the data channel once P2P opens (not the WS)", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
      iceServers: [],
      createConnection: fakePcFactory(),
    });
    const transports: string[] = [];
    client.on("transport", (v: string) => transports.push(v));
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    // peer-joined → we are the existing peer → initiator → channel opens
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    ws.emit({ type: "peer-joined", peerCount: 2 });
    await waitFor(() => transports.includes("p2p"));
    const wsSentBefore = ws.sent.length;
    await client.send("over p2p");
    expect(transports).toContain("p2p");
    // The clip did NOT go over the WS (it went over the data channel).
    expect(ws.sent.length).toBe(wsSentBefore);
  });

  it("falls back to relay transport when the peer leaves", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
      iceServers: [],
      createConnection: fakePcFactory(),
    });
    const transports: string[] = [];
    client.on("transport", (v: string) => transports.push(v));
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
    ws.emit({ type: "peer-joined", peerCount: 2 });
    await waitFor(() => transports.includes("p2p"));
    ws.emit({ type: "peer-left", peerCount: 1 });
    await waitFor(() => transports.at(-1) === "relay");
    await client.send("after p2p");
    const last = JSON.parse(ws.sent.at(-1)!);
    expect(last.type).toBe("clip"); // back on the WS
  });

  it("routes inbound sdp/ice into the PeerLink, not into content events", async () => {
    const client = new UniclipClient({
      roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
      relayBase: "wss://uniclip.app",
      iceServers: [],
      createConnection: fakePcFactory(),
    });
    let clips = 0;
    client.on("clip", () => clips++);
    await client.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });
    ws.emit({ type: "ice", from: "peer", candidate: "" });
    ws.emit({ type: "sdp", from: "peer", description: { type: "answer", sdp: "X" } });
    await new Promise((r) => setTimeout(r, 10));
    expect(clips).toBe(0); // signaling never surfaces as content
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uniclip/client-core test client`
Expected: FAIL — no `transport` event, no `createConnection`/`iceServers` options, clips still go over the WS.

- [ ] **Step 3: Implement the seam**

In `packages/client-core/src/client.ts`:

(a) Imports + option/event types:

```ts
import { ICE_SERVERS } from "@uniclip/protocol";
import { PeerLink, type PeerRole, type PeerSignal } from "./peer-link";
```

Add to `ClientEvent`:

```ts
  | { kind: "transport"; value: "p2p" | "relay" }
```

Add to `EventHandlers`:

```ts
  transport: (value: "p2p" | "relay") => void;
```

Add to `UniclipClientOptions`:

```ts
  iceServers?: RTCIceServer[];
  createConnection?: (config: RTCConfiguration) => RTCPeerConnection;
```

Add the emit case in the `switch` inside `emit`:

```ts
        case "transport": (cb as EventHandlers["transport"])(evt.value); break;
```

(b) New fields:

```ts
  private peer: PeerLink | null = null;
  private transport: "p2p" | "relay" = "relay";
  private readonly iceServers: RTCIceServer[];
  private readonly createConnection?: (config: RTCConfiguration) => RTCPeerConnection;
```

Set them in the constructor (near `this.relayBase = …`):

```ts
    this.iceServers = opts.iceServers ?? ICE_SERVERS;
    this.createConnection = opts.createConnection;
```

(c) Repoint the `FileTransferManager` send callback (in the constructor) from the inline WS send to the seam:

```ts
      send: (frame) => this.sendFrame(frame),
```

(d) The transport seam + arming. Add methods:

```ts
  // Prefer the P2P data channel; fall back to the WS. Returns false only when
  // BOTH are unavailable (caller decides whether to queue).
  private sendFrame(frame: ClientFrame): boolean {
    const payload = JSON.stringify(frame);
    if (this.peer?.isOpen()) {
      if (this.peer.send(payload)) return true;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
      return true;
    }
    return false;
  }

  private setTransport(value: "p2p" | "relay"): void {
    if (this.transport === value) return;
    this.transport = value;
    this.emit({ kind: "transport", value });
  }

  private armPeer(role: PeerRole): void {
    this.peer?.close();
    this.peer = new PeerLink({
      role,
      iceServers: this.iceServers,
      createConnection: this.createConnection,
      signal: (s: PeerSignal) => {
        // Signaling ALWAYS rides the WS — never the channel it is establishing.
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(s));
      },
      onOpen: () => this.setTransport("p2p"),
      onMessage: (data) => void this.handleFrame(data).catch(() => undefined),
      onClose: () => {
        this.setTransport("relay");
        this.transfers.abortAll("disconnected"); // live-only transfers cannot survive a channel drop
      },
    });
    this.peer.start();
  }

  private teardownPeer(): void {
    this.peer?.close();
    this.peer = null;
    this.setTransport("relay");
  }
```

(e) Use `sendFrame` in `send()` and `delete()`. Replace the WS-open branch of `send()`:

```ts
    if (this.sendFrame(frame)) {
      return { msgId, ts, queued: false };
    }
    // Offline: queue for flush on the next hello. ts is frozen at composition.
    this.enqueue(payload);
    return { msgId, ts, queued: true };
```

and the WS-open branch of `delete()`:

```ts
    if (this.sendFrame(frame)) {
      return;
    }
```

(leave the rest of `delete()`'s offline logic unchanged).

(f) Presence-driven arming + signaling routing in `handleFrame`. In the `case "hello":` block, after the existing emits and `this.flushQueue()`:

```ts
        // Newcomer that already sees a peer → we are the polite responder.
        if (frame.peerCount >= 2) this.armPeer("responder");
```

Replace the `case "peer-joined": case "peer-left":` block with:

```ts
      case "peer-joined":
        this.emit({ kind: "peer", count: frame.peerCount });
        // Someone joined while we were already here → we are the impolite initiator.
        if (frame.peerCount >= 2 && !this.peer) this.armPeer("initiator");
        return;
      case "peer-left":
        this.emit({ kind: "peer", count: frame.peerCount });
        if (frame.peerCount < 2) this.teardownPeer();
        return;
```

Add signaling cases before the `case "error":`:

```ts
      case "sdp":
      case "ice":
        await this.peer?.handleSignal(frame as PeerSignal);
        return;
```

(g) Tear down on WS close and disconnect. In `handleClose()`, after `this.transfers.abortAll(...)`:

```ts
    this.teardownPeer(); // a fresh hello re-arms once a peer is present again
```

In `disconnect()`, after `this.transfers.abortAll("disconnected");`:

```ts
    this.peer?.close();
    this.peer = null;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @uniclip/client-core test`
Expected: PASS (existing suite + 3 new transport tests). Then `pnpm --filter @uniclip/client-core typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/client-core/src/client.ts packages/client-core/src/client.test.ts
git commit -m "feat(client-core): transport seam — prefer P2P data channel, fall back to relay

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: web — transport badge

**Files:**
- Modify: `apps/web/src/routes/room.svelte`
- Test: covered by the e2e in Task 6 (no unit test; this is cosmetic wiring).

**Interfaces:**
- Consumes: the `transport` client event (Task 4).
- Produces: a `data-testid="transport"` element reading `Direct` / `Relayed` that the e2e asserts.

- [ ] **Step 1: Add the state + subscription**

In `apps/web/src/routes/room.svelte`, near the other `$state` declarations (around line 40-42):

```svelte
  let transport = $state<"p2p" | "relay">("relay");
```

In the subscription block (near line 58-60, beside `c.on("status", …)`):

```svelte
    c.on("transport", (v) => (transport = v));
```

- [ ] **Step 2: Render the badge**

Add a small badge in the header area. Near the `{peerCount}` / `{status}` usage (around line 276), add (or pass into `<Header>` as a prop if you prefer — minimal version renders inline):

```svelte
    <span
      data-testid="transport"
      class="rounded-field px-2 py-0.5 text-[11px] {transport === 'p2p' ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-faint'}"
      title={transport === "p2p" ? "Direct peer-to-peer (LAN when local)" : "Relayed through the server"}
    >
      {transport === "p2p" ? "Direct" : "Relayed"}
    </span>
```

> `bg-accent/15` uses a CSS-var color, which (per the Tailwind-4 Safari memo) degrades to an opaque base — safe. Avoid `bg-black/NN`-style literal-color opacity utilities for anything that must render on Safari.

- [ ] **Step 3: Verify it renders**

Run: `pnpm --filter @uniclip/web typecheck` (svelte-check) → clean.
Run: `pnpm --filter @uniclip/web test` → existing suite still green (44/44).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/room.svelte
git commit -m "feat(web): Direct/Relayed transport badge

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: e2e — P2P delivery + relay regression

**Files:**
- Create: `e2e/tests/webrtc.spec.ts`

**Interfaces:**
- Consumes: the running relay + web dev servers (the e2e harness boots them, per `pnpm test:e2e`). Follow the exact pattern in `e2e/tests/two-browser.spec.ts`: `chromium.launch()`, create the room through the UI (`Zero-knowledge` → `Create encrypted room`), read `pageA.url()`, navigate B, wait for the `secure channel` status pill, send via the textbox + `Send` button.

- [ ] **Step 1: Write the test**

Create `e2e/tests/webrtc.spec.ts`, modeled exactly on `two-browser.spec.ts`:

```ts
import { test, expect, chromium } from "@playwright/test";

test("clip travels and the Direct badge appears over WebRTC", async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const ctxB = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await pageA.goto("/");
  await pageA.getByRole("button", { name: /Zero-knowledge/i }).click();
  await pageA.getByRole("button", { name: /Create encrypted room/i }).click();
  await expect(pageA).toHaveURL(/\/r\/[a-z2-9]{6}#/);
  const roomUrl = pageA.url();
  await pageB.goto(roomUrl);

  await expect(pageA.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });
  await expect(pageB.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });

  // Both peers present → WebRTC should connect via Chromium loopback ICE.
  await expect(pageA.getByTestId("transport")).toHaveText("Direct", { timeout: 15_000 });

  await pageA.getByRole("textbox").fill("hello over p2p");
  await pageA.getByRole("button", { name: /^Send$/i }).click();
  await expect(pageB.getByText("hello over p2p")).toBeVisible({ timeout: 10_000 });

  await browser.close();
});

test("falls back to Relayed and still delivers when P2P is forced off", async () => {
  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const ctxB = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await pageA.goto("/");
  await pageA.getByRole("button", { name: /Zero-knowledge/i }).click();
  await pageA.getByRole("button", { name: /Create encrypted room/i }).click();
  await expect(pageA).toHaveURL(/\/r\/[a-z2-9]{6}#/);
  const roomUrl = pageA.url();
  // ?forceRelay=1 makes room.svelte build the client with iceServers:[] and skip
  // arming the PeerLink (see Step 2). Append before the #fragment so the secret
  // is preserved: insert the query on the path portion.
  const relayUrl = roomUrl.replace("#", "?forceRelay=1#");
  await pageA.goto(relayUrl);
  await pageB.goto(relayUrl);

  await expect(pageA.getByText(/secure channel/i)).toBeVisible({ timeout: 5_000 });
  await expect(pageA.getByTestId("transport")).toHaveText("Relayed", { timeout: 10_000 });

  await pageA.getByRole("textbox").fill("hello over relay");
  await pageA.getByRole("button", { name: /^Send$/i }).click();
  await expect(pageB.getByText("hello over relay")).toBeVisible({ timeout: 10_000 });

  await browser.close();
});
```

- [ ] **Step 1b: Add the `?forceRelay=1` test hook**

In `apps/web/src/routes/room.svelte`, where the `UniclipClient` is constructed (the `onMount`/setup block around line 55), read the flag and disable P2P deterministically:

```svelte
  const forceRelay = new URLSearchParams(location.search).has("forceRelay");
```

Pass `iceServers: forceRelay ? [] : undefined` into the `UniclipClient` options, and when `forceRelay` is set, also pass a `createConnection` that never opens a channel so no P2P can form:

```ts
    ...(forceRelay ? { iceServers: [], createConnection: () => { throw new Error("relay-forced"); } } : {}),
```

`armPeer` calls `this.peer.start()`, which calls `createConnection`; a throw there is caught by the surrounding `start()` try/catch path is NOT present, so guard it: in `PeerLink.start()`, wrap the `this.make(...)` call in try/catch and `return` (staying relayed) on throw. Add that guard in Task 3 if not already present, or keep `createConnection` returning a stub PC whose channel never opens (preferred — no throw):

```ts
    ...(forceRelay
      ? { iceServers: [], createConnection: () => ({
          onicecandidate: null, ondatachannel: null, onnegotiationneeded: null,
          onconnectionstatechange: null, signalingState: "stable", connectionState: "new",
          localDescription: null,
          createDataChannel: () => ({ readyState: "connecting", send() {}, close() {}, onopen: null, onclose: null, onmessage: null }),
          createOffer: async () => ({ type: "offer", sdp: "" }),
          createAnswer: async () => ({ type: "answer", sdp: "" }),
          setLocalDescription: async () => {}, setRemoteDescription: async () => {},
          addIceCandidate: async () => {}, close() {},
        }) as unknown as RTCPeerConnection }
      : {}),
```

This stub never fires `onopen`, so `transport` stays `relay` and content rides the WS. Keep it test-only behind the query flag.

- [ ] **Step 2: Run the e2e**

Run: `pnpm test:e2e`
Expected: the two new tests PASS along with the existing 9 (the suite boots its own relay + web dev servers). WebRTC loopback works in Playwright's Chromium; if the "Direct" assertion is flaky in CI, raise the timeout before weakening the assertion — do not delete it.

- [ ] **Step 3: Commit**

```bash
git add e2e/tests/webrtc.spec.ts apps/web/src/routes/room.svelte
git commit -m "test(e2e): WebRTC direct delivery + relay fallback

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] `pnpm typecheck` → clean across all packages.
- [ ] `pnpm test` → all unit suites green (protocol, crypto, client-core, relay, web).
- [ ] `pnpm test:e2e` → 11/11 (9 existing + 2 new).
- [ ] Manual cross-device smoke (per `CLAUDE.md`): `tailscale serve --bg 3000`, open the same room on two devices on the same LAN → badge reads **Direct**; open on cellular vs WiFi → still delivers (Direct via STUN, or Relayed fallback). Confirm a peer on an un-upgraded relay still syncs (Relayed).
- [ ] Update `CLAUDE.md`: the `apps/relay` / `client-core` bullets gain the signaling + P2P transport description; note "v0.1 is text-only" is stale (now E2EE text + chunked files + P2P fast path). (Fold into the Task 6 commit or a final `docs:` commit.)

## Spec coverage check (self-review)

- Spec §3 (sdp/ice frames) → Task 1. §4 (relay fan-out + `signalLimiter`, no buffering) → Task 2. §5.1 (transport seam) → Task 4(d-e). §5.2 (`PeerLink`, perfect negotiation, injectable) → Task 3. §5.3 (arming by presence, `transport` event, abort transfers on close) → Task 4(f-g). §6 (data flow + fallback) → Tasks 4 + 6. §7 (security: AES-GCM on top, relay blind, IP tradeoff) → preserved (no crypto change) + documented. §8 (test matrix) → Tasks 1-6.
- Open items deferred to plan-time decisions (spec §9): channel `{ordered:true}` chosen (Task 3); renegotiation = one attempt on `negotiationneeded` (Task 3); badge placement = inline in `room.svelte` (Task 5); minimal `RTCPeerConnectionLike` surface = the subset the fakes implement (Task 3 test).

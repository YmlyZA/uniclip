# CLI Node WebRTC (P4b-i) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `apps/cli` real peer-to-peer data transport by backing `PeerLink`'s injectable `createConnection` with **werift** (pure-TS WebRTC), so CLI clips travel P2P/LAN-direct with automatic relay fallback.

**Architecture:** Additive in `apps/cli` only. A thin adapter (`werift-peer.ts`) wraps werift's `RTCPeerConnection` and presents the DOM `RTCPeerConnection` surface that `client-core`'s `PeerLink` already consumes. `disabled-peer.ts` is kept as a `--relay-only` escape hatch. Signaling/discovery still ride the relay WS (zero-internet is the separate P4b-ii). No change to `client-core`, `protocol`, `relay`, or `crypto`.

**Tech Stack:** TypeScript, Node ≥ 22, werift `^0.23.0`, Ink/React (existing), vitest (plain Node runner).

## Global Constraints

- **No change to `client-core`, `protocol`, `relay`, or `crypto`.** werift is Node-only and must not leak into `client-core` (the web app uses the platform's native `RTCPeerConnection`). All new files live under `apps/cli/src/`.
- **werift stays external to the tsup bundle.** Do not add it to `noExternal` (which is `[/@uniclip\//]` only) — it is a normal runtime `dependency` resolved at install/`npx` time.
- **The AES-256-GCM envelope and WS-only signaling guards are untouched.** The adapter is pure transport plumbing under the existing envelope; `sdp`/`ice`/`rtc-hello` stay WS-only (the `via !== "ws"` guards in `client.ts` are not modified).
- **CLI tests run under plain Node vitest** (`environment: "node"`, `esbuild.jsx: "automatic"`). Tests are colocated next to source as `*.test.ts(x)` in `apps/cli/src/`.
- **Verified werift 0.23 API (use exactly these):**
  - `new RTCPeerConnection(config)` where `config.iceServers` is `{ urls: string; username?; credential? }[]` (note: `urls` is a single **string**, not `string|string[]`).
  - Events are rx-style subjects (guaranteed to fire): `pc.onIceCandidate.subscribe((c?: RTCIceCandidate) => …)`, `pc.onDataChannel.subscribe((dc) => …)`, `pc.onNegotiationneeded.subscribe(() => …)`, `pc.connectionStateChange.subscribe(() => …)`.
  - `pc.createDataChannel(label, { ordered })`, `pc.createOffer()`, `pc.createAnswer()`, `pc.setLocalDescription(desc)`, `pc.setRemoteDescription(desc)`, `pc.addIceCandidate(initOrCandidate)`, getter `pc.localDescription` (→ `{type,sdp}|undefined`), getter `pc.connectionState`, field `pc.signalingState`, `pc.close()` (returns a Promise).
  - `RTCIceCandidate.toJSON()` → `{ candidate, sdpMid, sdpMLineIndex }`; the parsed JSON is accepted back by `addIceCandidate`.
  - Data channel: `dc.stateChanged.subscribe((s: "connecting"|"open"|"closing"|"closed") => …)`, `dc.onMessage.subscribe((d: string | Buffer) => …)`, `dc.readyState`, `dc.send(string)`, `dc.close()`.

---

### Task 1: werift dependency + raw loopback smoke test

Proves werift installs and completes a real DTLS/ICE handshake in the vitest/Node sandbox, and pins the exact API the adapter bridges. (Validated during planning: a raw two-peer loopback connects in ~1.2s.)

**Files:**
- Modify: `apps/cli/package.json` (add `werift` to `dependencies`)
- Create: `apps/cli/src/werift-loopback.test.ts`

**Interfaces:**
- Consumes: werift's `RTCPeerConnection` (see Global Constraints API).
- Produces: nothing imported by later tasks; this task is a guard + API proof.

- [ ] **Step 1: Add the dependency**

Run: `cd apps/cli && pnpm add werift`
Expected: `package.json` gains `"werift": "^0.23.0"` under `dependencies`; lockfile updates.

- [ ] **Step 2: Write the loopback smoke test**

Create `apps/cli/src/werift-loopback.test.ts`:

```ts
import { expect, it } from "vitest";
import { RTCPeerConnection } from "werift";

// Proves werift completes a real handshake on loopback in this sandbox and
// pins the API the adapter (Task 2) bridges. No relay, no browser — pure Node.
it("two raw werift peers connect on loopback and exchange a datachannel message", async () => {
  const a = new RTCPeerConnection({ iceServers: [] });
  const b = new RTCPeerConnection({ iceServers: [] });
  a.onIceCandidate.subscribe((c) => c && void b.addIceCandidate(c.toJSON()));
  b.onIceCandidate.subscribe((c) => c && void a.addIceCandidate(c.toJSON()));

  const got = new Promise<string>((resolve) => {
    b.onDataChannel.subscribe((dc) => dc.onMessage.subscribe((d) => resolve(String(d))));
  });

  const dc = a.createDataChannel("uniclip", { ordered: true });
  const offer = await a.createOffer();
  await a.setLocalDescription(offer);
  await b.setRemoteDescription(a.localDescription!);
  const answer = await b.createAnswer();
  await b.setLocalDescription(answer);
  await a.setRemoteDescription(b.localDescription!);

  await new Promise<void>((res) => dc.stateChanged.subscribe((s) => s === "open" && res()));
  dc.send("hello-p2p");
  expect(await got).toBe("hello-p2p");
  await a.close();
  await b.close();
}, 20000);
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `cd apps/cli && pnpm exec vitest run src/werift-loopback.test.ts`
Expected: PASS in ~1–3s. (If it FAILS with a UDP/permission error, the sandbox blocks loopback UDP — stop and report; do not silently skip.)

- [ ] **Step 4: Commit**

```bash
git add apps/cli/package.json pnpm-lock.yaml apps/cli/src/werift-loopback.test.ts
git commit -m "feat(cli): add werift + raw loopback smoke test (P4b-i task 1)"
```

---

### Task 2: `werift-peer.ts` adapter + unit tests

The core of the slice: wrap werift to present the DOM `RTCPeerConnection` shape `PeerLink` consumes. Bridge werift's rx `Event` subjects → the DOM `onX` callbacks `PeerLink` assigns, coerce inbound datachannel messages to UTF-8 strings, and map `iceServers`.

**Files:**
- Create: `apps/cli/src/werift-peer.ts`
- Create: `apps/cli/src/werift-peer.test.ts`

**Interfaces:**
- Consumes: werift `RTCPeerConnection` / `RTCDataChannel` (Global Constraints API).
- Produces: `export const weriftPeer = (config: RTCConfiguration): RTCPeerConnection` — the factory `session.ts` (Task 4) injects as `createConnection`. It returns an object structurally satisfying the subset of `RTCPeerConnection` that `PeerLink` uses: settable `onicecandidate`/`ondatachannel`/`onnegotiationneeded`/`onconnectionstatechange`; `createDataChannel(label, {ordered})`; `createOffer()`/`createAnswer()`/`setLocalDescription()`/`setRemoteDescription()`/`addIceCandidate()`; getters `localDescription`/`connectionState`/`signalingState`; `close()`.

- [ ] **Step 1: Write the failing unit test**

Create `apps/cli/src/werift-peer.test.ts`. These tests use a hand-rolled fake werift `pc` (rx-subject shaped) so they stay fast and offline — the real-werift proof is Tasks 1 & 3.

```ts
import { describe, expect, it, vi } from "vitest";

// A minimal fake of a werift RTCPeerConnection: each "Event" is an object with
// a .subscribe(cb) that records cb so the test can fire it. Mirrors werift's API.
function mkSubject<T>() {
  const cbs: ((v: T) => void)[] = [];
  return { subscribe: (cb: (v: T) => void) => cbs.push(cb), fire: (v: T) => cbs.forEach((c) => c(v)) };
}
function fakeChannel() {
  const stateChanged = mkSubject<string>();
  const onMessage = mkSubject<string | Buffer>();
  return { stateChanged, onMessage, readyState: "connecting", sent: [] as string[], send(d: string) { this.sent.push(d); }, close: vi.fn() };
}
function fakeWerift() {
  const onIceCandidate = mkSubject<{ toJSON(): unknown } | undefined>();
  const onDataChannel = mkSubject<ReturnType<typeof fakeChannel>>();
  const onNegotiationneeded = mkSubject<void>();
  const connectionStateChange = mkSubject<void>();
  const created: ReturnType<typeof fakeChannel>[] = [];
  return {
    onIceCandidate, onDataChannel, onNegotiationneeded, connectionStateChange, created,
    iceServers: undefined as unknown,
    connectionState: "new", signalingState: "stable", localDescription: { type: "offer", sdp: "SDP" },
    createDataChannel: vi.fn(function (this: any) { const c = fakeChannel(); created.push(c); return c; }),
    createOffer: vi.fn(async () => ({ type: "offer", sdp: "OFFER" })),
    createAnswer: vi.fn(async () => ({ type: "answer", sdp: "ANSWER" })),
    setLocalDescription: vi.fn(async () => {}), setRemoteDescription: vi.fn(async () => {}),
    addIceCandidate: vi.fn(async () => {}), close: vi.fn(async () => {}),
  };
}

// Inject the fake werift constructor into werift-peer via the module's test hook.
import { weriftPeerWith } from "./werift-peer";

describe("weriftPeer adapter", () => {
  it("re-dispatches werift ICE candidates to onicecandidate with a toJSON-able candidate", () => {
    const w = fakeWerift();
    const pc = weriftPeerWith(() => w as any, { iceServers: [] });
    const seen: unknown[] = [];
    pc.onicecandidate = (ev: any) => seen.push(ev.candidate);
    const cand = { toJSON: () => ({ candidate: "x" }) };
    w.onIceCandidate.fire(cand);
    w.onIceCandidate.fire(undefined); // end-of-candidates
    expect(seen).toEqual([cand, null]);
  });

  it("synthesizes onnegotiationneeded from werift's onNegotiationneeded", () => {
    const w = fakeWerift();
    const pc = weriftPeerWith(() => w as any, { iceServers: [] });
    const fn = vi.fn();
    pc.onnegotiationneeded = fn;
    w.onNegotiationneeded.fire();
    expect(fn).toHaveBeenCalledOnce();
  });

  it("wraps an inbound data channel and coerces Buffer messages to strings", () => {
    const w = fakeWerift();
    const pc = weriftPeerWith(() => w as any, { iceServers: [] });
    let channel: any;
    pc.ondatachannel = (ev: any) => (channel = ev.channel);
    const dc = fakeChannel();
    w.onDataChannel.fire(dc);
    const msgs: string[] = [];
    channel.onmessage = (ev: { data: string }) => msgs.push(ev.data);
    dc.onMessage.fire(Buffer.from("héllo", "utf8"));
    dc.onMessage.fire("plain");
    expect(msgs).toEqual(["héllo", "plain"]);
  });

  it("maps channel open/close via stateChanged and forwards send/readyState", () => {
    const w = fakeWerift();
    const pc = weriftPeerWith(() => w as any, { iceServers: [] }) as any;
    const ch = pc.createDataChannel("uniclip", { ordered: true });
    const inner = w.created[0]!;
    let opened = false, closed = false;
    ch.onopen = () => (opened = true);
    ch.onclose = () => (closed = true);
    inner.stateChanged.fire("open");
    expect(opened).toBe(true);
    ch.send("frame");
    expect(inner.sent).toEqual(["frame"]);
    inner.stateChanged.fire("closed");
    expect(closed).toBe(true);
  });

  it("exposes connectionState/localDescription getters and fires onconnectionstatechange", () => {
    const w = fakeWerift();
    const pc = weriftPeerWith(() => w as any, { iceServers: [] }) as any;
    const fn = vi.fn();
    pc.onconnectionstatechange = fn;
    w.connectionState = "connected";
    w.connectionStateChange.fire();
    expect(fn).toHaveBeenCalledOnce();
    expect(pc.connectionState).toBe("connected");
    expect(pc.localDescription).toEqual({ type: "offer", sdp: "SDP" });
  });

  it("maps DOM iceServers (urls string|string[]) to werift's single-string urls", () => {
    let captured: any;
    const make = (cfg: any) => { captured = cfg; return fakeWerift() as any; };
    weriftPeerWith(make, { iceServers: [{ urls: ["stun:a:1", "stun:b:2"] }, { urls: "stun:c:3" }] });
    expect(captured.iceServers).toEqual([{ urls: "stun:a:1" }, { urls: "stun:c:3" }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/cli && pnpm exec vitest run src/werift-peer.test.ts`
Expected: FAIL — `weriftPeerWith` is not exported / module has no implementation.

- [ ] **Step 3: Implement the adapter**

Create `apps/cli/src/werift-peer.ts`:

```ts
import { RTCPeerConnection as WeriftPC } from "werift";

// werift may deliver a data-channel message as a Buffer; PeerLink expects a
// string. Coerce every inbound message to UTF-8.
function asString(d: string | Buffer | ArrayBuffer): string {
  if (typeof d === "string") return d;
  return Buffer.from(d as Buffer).toString("utf8");
}

// DOM RTCIceServer.urls may be string | string[]; werift wants a single string.
function toWeriftIceServers(config: RTCConfiguration): { urls: string; username?: string; credential?: string }[] {
  return (config.iceServers ?? []).map((s) => {
    const urls = Array.isArray(s.urls) ? s.urls[0]! : s.urls;
    return {
      urls,
      ...(s.username ? { username: s.username } : {}),
      ...(typeof s.credential === "string" ? { credential: s.credential } : {}),
    };
  });
}

// Wraps a werift data channel as the DOM RTCDataChannel surface PeerLink uses.
class ChannelAdapter {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(private readonly dc: any) {
    dc.stateChanged.subscribe((s: string) => {
      if (s === "open") this.onopen?.();
      else if (s === "closed") this.onclose?.();
    });
    dc.onMessage.subscribe((d: string | Buffer) => this.onmessage?.({ data: asString(d) }));
  }
  get readyState(): string { return this.dc.readyState; }
  send(data: string): void { this.dc.send(data); }
  close(): void { this.dc.close(); }
}

// Wraps a werift RTCPeerConnection as the DOM RTCPeerConnection surface PeerLink
// uses. Bridges werift's rx Event subjects to the DOM onX callbacks PeerLink
// assigns. The subjects (not werift's own onX fields) are the canonical, always-
// fired channel, so this works regardless of werift's DOM-callback behavior.
class PeerAdapter {
  onicecandidate: ((ev: { candidate: { toJSON(): unknown } | null }) => void) | null = null;
  ondatachannel: ((ev: { channel: ChannelAdapter }) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  private readonly pc: any;

  constructor(make: (cfg: any) => any, config: RTCConfiguration) {
    this.pc = make({ iceServers: toWeriftIceServers(config) });
    this.pc.onIceCandidate.subscribe((c: { toJSON(): unknown } | undefined) =>
      this.onicecandidate?.({ candidate: c ?? null }),
    );
    this.pc.onDataChannel.subscribe((dc: any) =>
      this.ondatachannel?.({ channel: new ChannelAdapter(dc) }),
    );
    this.pc.onNegotiationneeded.subscribe(() => this.onnegotiationneeded?.());
    this.pc.connectionStateChange.subscribe(() => this.onconnectionstatechange?.());
  }

  get connectionState(): string { return this.pc.connectionState; }
  get signalingState(): string { return this.pc.signalingState; }
  get localDescription(): { type: string; sdp: string } | null { return this.pc.localDescription ?? null; }

  createDataChannel(label: string, opts?: { ordered?: boolean }): ChannelAdapter {
    return new ChannelAdapter(this.pc.createDataChannel(label, opts));
  }
  createOffer(): Promise<{ type: string; sdp: string }> { return this.pc.createOffer(); }
  createAnswer(): Promise<{ type: string; sdp: string }> { return this.pc.createAnswer(); }
  setLocalDescription(d?: { type: "offer" | "answer"; sdp: string }): Promise<unknown> { return this.pc.setLocalDescription(d); }
  setRemoteDescription(d: { type: "offer" | "answer"; sdp: string }): Promise<unknown> { return this.pc.setRemoteDescription(d); }
  addIceCandidate(c: RTCIceCandidateInit): Promise<void> { return this.pc.addIceCandidate(c); }
  close(): void { void this.pc.close(); }
}

// Test hook: inject the werift constructor. Production code uses `weriftPeer`.
export function weriftPeerWith(
  make: (cfg: any) => any,
  config: RTCConfiguration,
): RTCPeerConnection {
  return new PeerAdapter(make, config) as unknown as RTCPeerConnection;
}

// A real Node WebRTC connection backed by werift, shaped as a DOM
// RTCPeerConnection so client-core's PeerLink drives it unchanged.
export const weriftPeer = (config: RTCConfiguration): RTCPeerConnection =>
  weriftPeerWith((cfg) => new WeriftPC(cfg), config);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/cli && pnpm exec vitest run src/werift-peer.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/werift-peer.ts apps/cli/src/werift-peer.test.ts
git commit -m "feat(cli): werift→DOM RTCPeerConnection adapter (P4b-i task 2)"
```

---

### Task 3: PeerLink + weriftPeer loopback integration test (gating proof)

The high-value test: drive two real `client-core` `PeerLink`s — each using `weriftPeer` — through an in-memory signaling relay, and assert the data channel opens and a JSON clip frame crosses peer-to-peer. This proves the adapter drives `PeerLink`'s real role-handshake + `onnegotiationneeded`-triggered offer flow end-to-end, in pure Node.

**Files:**
- Create: `apps/cli/src/peerlink-werift.test.ts`

**Interfaces:**
- Consumes: `weriftPeer` (Task 2); `PeerLink`/`PeerSignal` from `@uniclip/client-core/src/peer-link` (deep import — verified to resolve; keeps `client-core` unchanged per the spec).
- Produces: nothing; final transport proof.

- [ ] **Step 1: Write the failing test**

Create `apps/cli/src/peerlink-werift.test.ts`:

```ts
import { expect, it } from "vitest";
import { PeerLink, type PeerSignal } from "@uniclip/client-core/src/peer-link";
import { weriftPeer } from "./werift-peer";

// Two PeerLinks, each backed by a real werift connection. Their signal()
// callbacks hand PeerSignals to each other (an in-memory stand-in for the relay
// WS). Asserts the channel opens and a clip frame crosses P2P — no relay buffer,
// no browser. This is the gate: if this fails, the adapter is wrong, not the wiring.
it("two PeerLinks over werift open a channel and exchange a clip frame", async () => {
  let a!: PeerLink, b!: PeerLink;
  const received: string[] = [];
  let aOpen = false, bOpen = false;

  // Deliver async so we never re-enter handleSignal synchronously.
  const send = (to: () => PeerLink) => (s: PeerSignal) =>
    void Promise.resolve().then(() => to().handleSignal(s));

  a = new PeerLink({
    iceServers: [], createConnection: weriftPeer,
    signal: send(() => b),
    onOpen: () => (aOpen = true), onClose: () => {}, onMessage: () => {},
  });
  b = new PeerLink({
    iceServers: [], createConnection: weriftPeer,
    signal: send(() => a),
    onOpen: () => (bOpen = true),
    onClose: () => {}, onMessage: (d) => received.push(d),
  });

  a.start();
  b.start();

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("channel did not open in time")), 15000);
    const check = setInterval(() => {
      if (aOpen && bOpen) { clearInterval(check); clearTimeout(t); resolve(); }
    }, 50);
  });

  const frame = JSON.stringify({ type: "clip", msgId: "x", iv: "i", ciphertext: "c", ts: 1 });
  // Send from whichever side ended up the initiator/responder — both channels are open.
  expect(a.send(frame)).toBe(true);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("frame not received")), 5000);
    const check = setInterval(() => {
      if (received.length > 0) { clearInterval(check); clearTimeout(t); resolve(); }
    }, 50);
  });

  expect(received[0]).toBe(frame);
  a.close();
  b.close();
}, 25000);
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `cd apps/cli && pnpm exec vitest run src/peerlink-werift.test.ts`
Expected: PASS in ~2–5s. (Validated in planning that raw werift loopback connects in ~1.2s; PeerLink adds the role handshake.) If it FAILS at "channel did not open", the most likely cause is `onnegotiationneeded` not firing — re-check that `PeerAdapter` subscribes to `onNegotiationneeded` and that `PeerLink` assigns the handler before `createDataChannel` (`peer-link.ts:93-94`); report rather than loosen the assertion.

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/peerlink-werift.test.ts
git commit -m "test(cli): PeerLink+werift loopback proves real P2P (P4b-i task 3)"
```

---

### Task 4: Wire the factory + `--relay-only` flag

Make `weriftPeer` the default `createConnection` and keep `disabledPeer` reachable via `--relay-only`. The Direct/Relayed header indicator already works (`app.tsx:55-56` maps the `transport` event to the status line) — it simply starts flipping to "direct" now that P2P can open, so no UI task is needed.

**Files:**
- Modify: `apps/cli/src/args.ts` (+ `apps/cli/src/args.test.ts`)
- Modify: `apps/cli/src/session.ts` (+ `apps/cli/src/session.test.ts`)
- Modify: `apps/cli/src/cli.tsx`

**Interfaces:**
- Consumes: `weriftPeer` (Task 2), existing `disabledPeer`.
- Produces: `parseArgs(argv) → { roomUrl?, relay, name?, relayOnly: boolean }`; `makeClient({ roomUrl, deviceName?, relayOnly? })` selecting the factory.

- [ ] **Step 1: Write the failing `args` test**

Add to `apps/cli/src/args.test.ts`:

```ts
it("defaults relayOnly to false and parses --relay-only", () => {
  expect(parseArgs(["https://h/r/abc#sek"]).relayOnly).toBe(false);
  const a = parseArgs(["--relay-only", "https://h/r/abc#sek"]);
  expect(a.relayOnly).toBe(true);
  expect(a.roomUrl).toBe("https://h/r/abc#sek");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/cli && pnpm exec vitest run src/args.test.ts`
Expected: FAIL — `relayOnly` is `undefined`.

- [ ] **Step 3: Implement in `args.ts`**

Modify `apps/cli/src/args.ts` — add `relayOnly` to the return type, initialize `let relayOnly = false;`, add a branch in the loop, and include it in the return:

```ts
export function parseArgs(argv: string[]): { roomUrl?: string; relay: string; name?: string; relayOnly: boolean } {
  let roomUrl: string | undefined;
  let relay = process.env.UNICLIP_RELAY ?? "http://localhost:3000";
  let name: string | undefined;
  let relayOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--relay") { relay = argv[++i] ?? relay; }
    else if (a === "--name") { name = argv[++i]; }
    else if (a === "--relay-only") { relayOnly = true; }
    else if (!a.startsWith("-")) { roomUrl = a; }
  }
  return {
    ...(roomUrl !== undefined ? { roomUrl } : {}),
    relay,
    ...(name !== undefined ? { name } : {}),
    relayOnly,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/cli && pnpm exec vitest run src/args.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing `session` test**

Add to `apps/cli/src/session.test.ts` (import is already `import { makeClient } from "./session"` — add `makeClient` to the existing import from `./session`):

```ts
import { makeClient } from "./session";

describe("makeClient factory selection", () => {
  const url = "http://localhost:3000/r/abc123#sekretsekretsekret";
  it("defaults to a real (werift) peer — its data channel is not the never-opening stub", () => {
    const c = makeClient({ roomUrl: url }) as any;
    // The disabledPeer stub's channel is permanently "connecting"; a real werift
    // channel reports "connecting" initially too, so assert via the injected factory instead:
    expect(typeof c).toBe("object");
  });
  it("uses the never-opening disabledPeer when relayOnly is set", () => {
    // Inspect the createConnection the client was built with by constructing a peer.
    const c = makeClient({ roomUrl: url, relayOnly: true }) as any;
    expect(typeof c).toBe("object");
  });
});
```

> Note: `UniclipClient` does not expose its `createConnection`, so assert factory selection at the unit boundary instead — see Step 6's preferred test. Replace the placeholder block above with the Step 6 test.

- [ ] **Step 6: Make factory selection unit-testable and test it**

Refactor `session.ts` so the factory choice is a pure, exported function, then test that directly (clean and deterministic — no need to reach into `UniclipClient`).

Modify `apps/cli/src/session.ts`:

```ts
import { UniclipClient } from "@uniclip/client-core";
import { generateModeARoom } from "@uniclip/room-code";
import { disabledPeer } from "./disabled-peer";
import { weriftPeer } from "./werift-peer";

// … relayBaseFromUrl and createRoom unchanged …

// The WebRTC factory for a session: real werift by default, the never-opening
// stub when the user forces relay-only.
export function peerFactory(relayOnly: boolean): (config: RTCConfiguration) => RTCPeerConnection {
  return relayOnly ? disabledPeer : weriftPeer;
}

// Build a UniclipClient. P2P uses werift unless relayOnly forces the relay.
export function makeClient(opts: { roomUrl: string; deviceName?: string; relayOnly?: boolean }): UniclipClient {
  return new UniclipClient({
    roomUrl: opts.roomUrl,
    relayBase: relayBaseFromUrl(opts.roomUrl),
    createConnection: peerFactory(opts.relayOnly ?? false),
    ...(opts.deviceName ? { deviceName: opts.deviceName } : {}),
  });
}
```

Replace the Step-5 placeholder in `session.test.ts` with:

```ts
import { peerFactory } from "./session";
import { weriftPeer } from "./werift-peer";

describe("peerFactory", () => {
  it("defaults to weriftPeer (real P2P)", () => {
    expect(peerFactory(false)).toBe(weriftPeer);
  });
  it("returns the never-opening disabledPeer when relay-only", () => {
    expect(peerFactory(true)).toBe(disabledPeer);
    const ch = peerFactory(true)({ iceServers: [] }).createDataChannel("uniclip");
    expect(ch.readyState).toBe("connecting"); // never opens → forces relay
  });
});
```

- [ ] **Step 7: Run to verify session tests pass**

Run: `cd apps/cli && pnpm exec vitest run src/session.test.ts`
Expected: PASS.

- [ ] **Step 8: Thread `relayOnly` through `cli.tsx`**

Modify `apps/cli/src/cli.tsx`: destructure `relayOnly` from `parseArgs` and pass it to `makeClient`:

```ts
const { roomUrl: arg, relay, name, relayOnly } = parseArgs(process.argv.slice(2));
// … unchanged room resolution …
const client = makeClient({ roomUrl, relayOnly, ...(name ? { deviceName: name } : {}) });
```

- [ ] **Step 9: Full CLI suite + typecheck**

Run: `cd apps/cli && pnpm exec vitest run && pnpm typecheck`
Expected: all tests PASS, no type errors.

- [ ] **Step 10: Commit**

```bash
git add apps/cli/src/args.ts apps/cli/src/args.test.ts apps/cli/src/session.ts apps/cli/src/session.test.ts apps/cli/src/cli.tsx
git commit -m "feat(cli): default to werift P2P, add --relay-only escape hatch (P4b-i task 4)"
```

---

## Final verification (after all tasks)

- [ ] **Build the bin** (werift must stay external; bundle must still emit):

Run: `cd apps/cli && pnpm build`
Expected: `dist/cli.js` emitted with the shebang; no attempt to bundle werift's native-ish modules.

- [ ] **Repo-wide gates from root:**

Run: `pnpm typecheck && pnpm test`
Expected: all packages green (CLI suite includes the werift loopback + adapter + integration tests).

- [ ] **Update `CLAUDE.md`** — the `apps/cli` bullet says "Relay-only: P2P is disabled by injecting a never-opening createConnection stub." Update it to: P2P is real via a werift adapter (`werift-peer.ts`), default-on with relay fallback; `--relay-only` injects the `disabledPeer` stub; true zero-internet (mDNS + local signaling) remains the deferred P4b-ii. Commit:

```bash
git add CLAUDE.md
git commit -m "docs: CLI now does real werift P2P (P4b-i), relay-only via flag"
```

## Self-Review (completed during planning)

- **Spec coverage:** Goal 1 (P2P data) → Tasks 2+3; Goal 2 (werift adapter) → Task 2; Goal 3 (relay fallback) → unchanged in `client.ts`, exercised by `--relay-only` path + existing relay tests; Goal 4 (Direct/Relayed indicator) → already implemented (`app.tsx:55-56`), noted in Task 4; Goal 5 (`--relay-only`) → Task 4. Non-goals (no client-core/protocol/relay/crypto change) → enforced by Global Constraints; the loopback test deep-imports `PeerLink` rather than modifying client-core.
- **Placeholder scan:** Step 5 of Task 4 is intentionally a throwaway that Step 6 replaces — flagged inline as such so the implementer doesn't ship it.
- **Type consistency:** `weriftPeer`/`weriftPeerWith` signatures match across Tasks 2/3/4; `peerFactory(relayOnly: boolean)` and `makeClient({…relayOnly?})` are consistent; `parseArgs` return type extended uniformly.

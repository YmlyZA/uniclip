# Cross-Device Validation Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the cross-device validation matrix executable on real hardware by surfacing the transport state machine through a new `diag` event, consumed by a CLI `--verbose` logger and a Web debug overlay, plus a fillable runbook + result template.

**Architecture:** A new `diag` variant on `client-core`'s existing `ClientEvent` union taps seams that already exist (`peer-link.ts` observes ICE candidates + `connectionState`; `client.ts` drives ws/signal/decrypt/transport) without changing any transport behavior. Two consumers attach to the same event stream: a CLI stderr formatter (`--verbose`) and a Svelte overlay (`?debug`). Diagnostics carry metadata only (no secret/plaintext/ciphertext/key). Bugs the matrix surfaces are triaged separately, not in this plan.

**Tech Stack:** TypeScript everywhere. `client-core` (vitest, Node). `apps/cli` (Ink/React, vitest + ink-testing-library). `apps/web` (Svelte 5 runes, Vite 6, vitest — pure-function lib tests only, no component tests). Spec: `docs/superpowers/specs/2026-06-30-uniclip-cross-device-validation-design.md`.

## Global Constraints

- **Branch:** `feat/cross-device-diagnostics` (spec already committed `f347175`). Do not create a new branch.
- **No transport-behavior change.** Diagnostics only *read* existing state; never alter negotiation, routing, or fallback.
- **Privacy invariant (load-bearing):** diag events carry only routingId, msgIds, candidate types/protocols, connection states, ws codes. **Never** secret, plaintext, ciphertext, key, or full SDP bodies. A regression test asserts `decrypt-fail` detail/data contains no plaintext.
- **Diagnostics off by default.** CLI requires `--verbose`/`-V`/`UNICLIP_VERBOSE`; Web requires `?debug` or the `?` key. No cost when off.
- **Timestamps are added by consumers**, relative to session start — the `DiagEvent` itself carries no timestamp (keeps core clock-free).
- **Consumers match on `phase` + `data` fields, never by parsing `detail`** (detail is human copy and may change).
- **Web Tailwind caveat** (`tailwind4-safari-colormix-backdrop`): overlay background uses plain `rgba(...)` + `-webkit-`-prefixed blur, never `bg-black/NN` — mobile Safari is the row-B test surface.
- **client-core / cli tests run under Node vitest** (`pnpm --filter @uniclip/client-core test`, `pnpm --filter @uniclip/cli test`). Relay suite is untouched (no relay change).

---

### Task 1: `diag` event in client-core

**Files:**
- Create: `packages/client-core/src/diag.ts`
- Create: `packages/client-core/src/diag.test.ts`
- Modify: `packages/client-core/src/peer-link.ts` (`PeerLinkOptions` +`onDiag`; emit in `start`/`onicecandidate`/`onconnectionstatechange`/`wireChannel`)
- Modify: `packages/client-core/src/client.ts` (`ClientEvent`/`EventHandlers`/`emit`; `diag()` helper; emit at ws/signal/decrypt-fail/transport; wire peer `onDiag`)
- Modify: `packages/client-core/src/index.ts` (export `./diag`)
- Modify: `packages/client-core/src/peer-link.test.ts` (assert diag emissions)
- Modify: `packages/client-core/src/client.test.ts` (assert decrypt-fail + transport diag)

**Interfaces:**
- Produces:
  - `type DiagPhase = "ws" | "signal" | "ice-candidate" | "pc-state" | "dc" | "transport" | "decrypt-fail"`
  - `interface DiagEvent { kind: "diag"; phase: DiagPhase; level: "info" | "warn" | "error"; detail: string; data?: Record<string, string | number> }`
  - `function parseCandidate(sdp: string): { typ?: string; protocol?: string }`
  - `ClientEvent` gains `| DiagEvent`; `EventHandlers` gains `diag: (e: DiagEvent) => void`.
  - `PeerLinkOptions` gains `onDiag?: (e: DiagEvent) => void`.
  - Diag conventions later tasks match on:
    - `ws`: `data.event` ∈ `"connecting" | "open" | "close"`; close adds `data.code?` (number).
    - `ice-candidate`: `data.typ` ∈ `"host" | "srflx" | "relay" | "prflx"`, `data.protocol`.
    - `pc-state`: `data.state` = the `RTCPeerConnectionState`.
    - `dc`: `data.event` ∈ `"open" | "close"`.
    - `transport`: `data.value` ∈ `"p2p" | "relay"`.
    - `signal`: `data.dir` ∈ `"send" | "recv"`, `data.type` = the signal type.
    - `decrypt-fail`: `data.msgId` only.

- [ ] **Step 1: Write the failing test for `parseCandidate`**

Create `packages/client-core/src/diag.test.ts`:

```ts
import { expect, it } from "vitest";
import { parseCandidate } from "./diag";

it("parses typ and protocol from a host candidate string", () => {
  const sdp = "candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host";
  expect(parseCandidate(sdp)).toEqual({ typ: "host", protocol: "udp" });
});

it("parses a srflx (STUN) candidate", () => {
  const sdp = "candidate:2 1 udp 1686052607 203.0.113.5 9 typ srflx raddr 0.0.0.0 rport 0";
  expect(parseCandidate(sdp)).toEqual({ typ: "srflx", protocol: "udp" });
});

it("parses a relay (TURN) tcp candidate", () => {
  const sdp = "candidate:3 1 tcp 1518280447 198.51.100.2 443 typ relay";
  expect(parseCandidate(sdp)).toEqual({ typ: "relay", protocol: "tcp" });
});

it("returns empty object for an unparseable string", () => {
  expect(parseCandidate("garbage")).toEqual({});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @uniclip/client-core test diag`
Expected: FAIL — `parseCandidate` not found / module `./diag` missing.

- [ ] **Step 3: Create `diag.ts` with the types + parser**

Create `packages/client-core/src/diag.ts`:

```ts
// Diagnostic events: metadata-only visibility into the transport state machine.
// Emitted (opt-in consumers) so real-hardware failures are attributable.
// NEVER carry secret / plaintext / ciphertext / key / full SDP — metadata only.
export type DiagPhase =
  | "ws"            // websocket connect / open / close
  | "signal"        // sdp/ice/rtc-hello sent or received (WS-only) — type + direction
  | "ice-candidate" // a gathered local ICE candidate: typ + protocol
  | "pc-state"      // RTCPeerConnection connectionState transition
  | "dc"            // datachannel open / close
  | "transport"     // p2p <-> relay switch
  | "decrypt-fail"; // receive-side decrypt failed (msgId only)

export interface DiagEvent {
  kind: "diag";
  phase: DiagPhase;
  level: "info" | "warn" | "error";
  detail: string; // one human-readable line (for logs/overlay display)
  data?: Record<string, string | number>; // structured fields consumers match on
}

// Extract `typ` (host|srflx|relay|prflx) and transport protocol from an ICE
// candidate SDP string. Field 2 (0-indexed) is the protocol; `typ <x>` names
// the type. Returns {} when the string isn't a recognizable candidate.
export function parseCandidate(sdp: string): { typ?: string; protocol?: string } {
  if (!sdp.startsWith("candidate:")) return {};
  const out: { typ?: string; protocol?: string } = {};
  const parts = sdp.split(/\s+/);
  if (parts[2]) out.protocol = parts[2].toLowerCase();
  const m = / typ (\w+)/.exec(sdp);
  if (m?.[1]) out.typ = m[1];
  return out;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @uniclip/client-core test diag`
Expected: PASS (4 tests).

- [ ] **Step 5: Export diag from the package index**

Modify `packages/client-core/src/index.ts` — append:

```ts
export * from "./diag";
```

- [ ] **Step 6: Write the failing peer-link diag test**

Add to `packages/client-core/src/peer-link.test.ts`. First extend the `mk` helper to capture diag, and `FakePC` to drive connection state. Replace the existing `mk` function with:

```ts
function mk(extra: Partial<Record<"onOpen" | "onClose" | "onMessage", () => void>> = {}) {
  const out: PeerSignal[] = [];
  const diag: import("./diag").DiagEvent[] = [];
  const link = new PeerLink({
    iceServers: [], signal: (s) => out.push(s),
    onOpen: extra.onOpen ?? (() => {}), onClose: extra.onClose ?? (() => {}),
    onMessage: (extra.onMessage as ((d: string) => void)) ?? (() => {}),
    createConnection: mkPC,
    onDiag: (e) => diag.push(e),
  });
  return { link, out, diag };
}
```

Then add these tests at the end of the file:

```ts
it("emits an ice-candidate diag with parsed typ/protocol", () => {
  const { link, diag } = mk();
  link.start();
  FakePC.last.onicecandidate?.({
    candidate: { toJSON: () => ({ candidate: "candidate:1 1 udp 1 192.168.1.5 5 typ host" }) },
  } as any);
  const d = diag.find((e) => e.phase === "ice-candidate");
  expect(d?.data).toMatchObject({ typ: "host", protocol: "udp" });
});

it("emits a pc-state diag on connectionstatechange", () => {
  const { link, diag } = mk();
  link.start();
  (FakePC.last as any).connectionState = "connected";
  FakePC.last.onconnectionstatechange?.();
  expect(diag.find((e) => e.phase === "pc-state")?.data).toMatchObject({ state: "connected" });
});

it("emits a dc open diag when the channel opens", async () => {
  const { link, diag } = mk();
  link.start();
  await link.handleSignal({ type: "rtc-hello", from: MIN_FROM }); // we initiate → channel created
  FakePC.last.channels[0]!.open();
  expect(diag.find((e) => e.phase === "dc" && e.data?.event === "open")).toBeTruthy();
});
```

- [ ] **Step 7: Run to verify the new peer-link tests fail**

Run: `pnpm --filter @uniclip/client-core test peer-link`
Expected: FAIL — `onDiag` not in options / no diag emitted.

- [ ] **Step 8: Add `onDiag` + emissions to `peer-link.ts`**

In `packages/client-core/src/peer-link.ts`:

Add the import at the top (after line 2):

```ts
import { parseCandidate, type DiagEvent } from "./diag";
```

Add to `PeerLinkOptions` (after `createConnection?` line):

```ts
  onDiag?: (e: DiagEvent) => void;
```

Add a private emit helper inside the class (after the `make` field assignment in the constructor area, e.g. after line 40):

```ts
  private diag(phase: DiagEvent["phase"], level: DiagEvent["level"], detail: string, data?: Record<string, string | number>): void {
    this.opts.onDiag?.({ kind: "diag", phase, level, detail, ...(data ? { data } : {}) });
  }
```

In `start()`, extend `onicecandidate` to emit before signaling (replace the existing `pc.onicecandidate = ...` assignment):

```ts
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        const { typ, protocol } = parseCandidate(candidate.candidate ?? "");
        if (typ) this.diag("ice-candidate", "info", `${typ} ${protocol ?? ""}`.trim(), { typ, ...(protocol ? { protocol } : {}) });
      }
      this.opts.signal({
        type: "ice",
        from: this.from,
        candidate: candidate ? JSON.stringify(candidate.toJSON()) : "",
      });
    };
```

In `start()`, extend `onconnectionstatechange` (replace that block):

```ts
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      this.diag("pc-state", s === "failed" ? "error" : "info", s, { state: s });
      if (s === "failed" || s === "disconnected" || s === "closed") this.fireClose();
    };
```

In `wireChannel()`, add diag to open/close (replace the `ch.onopen`/`ch.onclose` lines):

```ts
    ch.onopen = () => { this.diag("dc", "info", "open", { event: "open" }); this.opts.onOpen(); };
    ch.onclose = () => { this.diag("dc", "warn", "close", { event: "close" }); this.fireClose(); };
```

- [ ] **Step 9: Run to verify peer-link tests pass**

Run: `pnpm --filter @uniclip/client-core test peer-link`
Expected: PASS (existing + 3 new).

- [ ] **Step 10: Write the failing client.ts diag tests**

The `decrypt-fail` test must prove the privacy invariant. Use the file's existing `MockWebSocket` harness (in scope in `client.test.ts`). Two clients with **different `#secret` fragments** derive different keys, so the receiver genuinely cannot decrypt the sender's frame — the real wrong-key path, with well-formed ciphertext. Add inside the `describe("UniclipClient", …)` block:

```ts
it("emits a decrypt-fail diag carrying only the msgId (no plaintext/ciphertext)", async () => {
  const sender = new UniclipClient({
    roomUrl: "https://uniclip.app/r/qx7k2p#aaaaaaaaaaaaaaaaaa",
    relayBase: "wss://uniclip.app",
  });
  const receiver = new UniclipClient({
    roomUrl: "https://uniclip.app/r/qx7k2p#bbbbbbbbbbbbbbbbbb", // different secret → different key
    relayBase: "wss://uniclip.app",
  });
  const diags: import("./diag").DiagEvent[] = [];
  receiver.on("diag", (e) => diags.push(e));
  await sender.connect();
  await receiver.connect();
  const senderWs = MockWebSocket.instances[0]!;
  const receiverWs = MockWebSocket.instances[1]!;
  senderWs.emit({ type: "hello", roomId: "qx7k2p", peerCount: 1, serverTime: 0, backfill: false });
  receiverWs.emit({ type: "hello", roomId: "qx7k2p", peerCount: 2, serverTime: 0, backfill: false });

  await sender.send("secret plaintext payload");
  const wire = JSON.parse(senderWs.sent.find((s) => JSON.parse(s).type === "clip")!);
  receiverWs.emit(wire);
  await waitFor(() => diags.some((e) => e.phase === "decrypt-fail"));

  const d = diags.find((e) => e.phase === "decrypt-fail")!;
  expect(d.data).toEqual({ msgId: wire.msgId });
  // Privacy lock: neither plaintext nor the wire ciphertext/iv leak into the event.
  const serialized = JSON.stringify(d);
  expect(serialized).not.toContain("secret plaintext payload");
  expect(serialized).not.toContain(wire.ciphertext);
  expect(serialized).not.toContain(wire.iv);
});

it("emits a transport diag when the channel opens (p2p) and closes (relay)", async () => {
  const client = new UniclipClient({
    roomUrl: "https://uniclip.app/r/qx7k2p#abcdefghijklmnopqr",
    relayBase: "wss://uniclip.app",
  });
  const diags: import("./diag").DiagEvent[] = [];
  client.on("diag", (e) => diags.push(e));
  await client.connect();
  // ws lifecycle diag fires on connect/open:
  await waitFor(() => diags.some((e) => e.phase === "ws" && e.data?.event === "open"));
  expect(diags.some((e) => e.phase === "ws" && e.data?.event === "connecting")).toBe(true);
});
```

> `MockWebSocket`, `waitFor`, and `UniclipClient` are all already defined at the top of `client.test.ts`; no new harness is needed.

- [ ] **Step 11: Run to verify it fails**

Run: `pnpm --filter @uniclip/client-core test client`
Expected: FAIL — no `decrypt-fail` diag emitted.

- [ ] **Step 12: Add the `diag` event + emissions to `client.ts`**

In `packages/client-core/src/client.ts`:

Import at top (extend the existing `./peer-link` import line is separate; add a new import after line 9):

```ts
import type { DiagEvent } from "./diag";
```

Add to the `ClientEvent` union (after the `presence` line, before `| FileClientEvent`):

```ts
  | DiagEvent
```

Add to `EventHandlers` (after the `presence` line):

```ts
  diag: (e: DiagEvent) => void;
```

Add to the `emit()` switch (after the `presence` case):

```ts
        case "diag": (cb as EventHandlers["diag"])(evt); break;
```

Add a private helper (next to `emit`, e.g. after the `emit` method closes at line 133):

```ts
  private diag(phase: DiagEvent["phase"], level: DiagEvent["level"], detail: string, data?: Record<string, string | number>): void {
    this.emit({ kind: "diag", phase, level, detail, ...(data ? { data } : {}) });
  }
```

Emit at the ws lifecycle in `openSocket()` (replace the body):

```ts
  private openSocket(): void {
    this.emit({ kind: "status", value: "connecting" });
    this.diag("ws", "info", "connecting", { event: "connecting" });
    const ws = new WebSocket(`${this.relayBase}/ws/${this.room.routingId}`);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff.reset();
      this.diag("ws", "info", "open", { event: "open" });
    };
    ws.onmessage = (ev) => this.handleFrame(ev.data as string).catch(() => undefined);
    ws.onclose = (ev) => {
      const code = (ev as CloseEvent | undefined)?.code;
      this.diag("ws", "warn", code ? `closed (${code})` : "closed", { event: "close", ...(typeof code === "number" ? { code } : {}) });
      this.handleClose();
    };
    ws.onerror = () => this.emit({ kind: "error", code: "WS_ERROR", message: "websocket error" });
  }
```

Emit `decrypt-fail` in the clip decrypt `catch` (inside `handleFrame`, in the `case "clip"` catch block, add as the first line of the `catch`):

```ts
        } catch {
          this.diag("decrypt-fail", "warn", "decrypt failed", { msgId: frame.msgId });
          // …existing DECRYPT_FAILED one-shot error emission unchanged…
```

Emit `signal` on receive (in `handleFrame`, the `case "sdp"`/`"ice"`/`"rtc-hello"` block, before `await this.peer?.handleSignal`):

```ts
      case "sdp":
      case "ice":
      case "rtc-hello":
        if (via !== "ws") return;
        this.diag("signal", "info", `<- ${frame.type}`, { dir: "recv", type: frame.type });
        await this.peer?.handleSignal(frame as PeerSignal);
        return;
```

Emit `signal` on send + wire `onDiag` in `armPeer()` (replace the `signal:` callback and add `onDiag`):

```ts
      signal: (s: PeerSignal) => {
        this.diag("signal", "info", `-> ${s.type}`, { dir: "send", type: s.type });
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(s));
      },
      onDiag: (e) => this.emit(e),
```

Emit `transport` in `setTransport()` (add after the assignment, before the existing emit):

```ts
  private setTransport(value: "p2p" | "relay"): void {
    if (this.transport === value) return;
    this.transport = value;
    this.diag("transport", "info", value === "p2p" ? "relay -> p2p" : "p2p -> relay", { value });
    this.emit({ kind: "transport", value });
  }
```

- [ ] **Step 13: Run to verify client tests pass**

Run: `pnpm --filter @uniclip/client-core test client`
Expected: PASS.

- [ ] **Step 14: Add a real-handshake diag trace assertion (werift loopback)**

In `apps/cli/src/werift-loopback.test.ts` (real two-peer werift handshake), attach a diag collector to one client and assert the ordered trace after the channel opens. Add inside the existing test that drives a successful loopback, after both peers connect:

```ts
// diag vocabulary is correct against a real WebRTC handshake:
const phases = collectedDiag.map((e) => e.phase);
expect(phases).toContain("ice-candidate");
expect(phases).toContain("pc-state");
expect(phases.indexOf("dc")).toBeGreaterThan(-1);
// dc open arrives after at least one pc-state:
expect(phases.indexOf("dc")).toBeGreaterThan(phases.indexOf("pc-state"));
```

> Wire `collectedDiag` by `client.on("diag", (e) => collectedDiag.push(e))` on whichever `UniclipClient` the test already builds, before connecting. If the test builds clients via a helper that hides the instance, add the listener at the earliest point the instance is available. Keep the assertion tolerant (presence + ordering), not exact counts — real ICE timing varies.

- [ ] **Step 15: Run the loopback test + full client-core + cli typecheck**

Run: `pnpm --filter @uniclip/cli test werift-loopback`
Expected: PASS (handshake + diag trace).
Run: `pnpm --filter @uniclip/client-core test && pnpm --filter @uniclip/client-core typecheck`
Expected: PASS / no type errors.

- [ ] **Step 16: Commit**

```bash
git add packages/client-core/src/diag.ts packages/client-core/src/diag.test.ts \
        packages/client-core/src/peer-link.ts packages/client-core/src/peer-link.test.ts \
        packages/client-core/src/client.ts packages/client-core/src/client.test.ts \
        packages/client-core/src/index.ts apps/cli/src/werift-loopback.test.ts
git commit -m "feat(client-core): diag event — metadata-only transport visibility

New DiagEvent on the ClientEvent union, tapping existing seams in
peer-link (ICE candidate typ/protocol, pc-state, datachannel) and client
(ws lifecycle, signal send/recv, decrypt-fail msgId-only, transport).
No transport behavior change; decrypt-fail carries no plaintext (locked
by test). Validated against a real werift handshake trace.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: CLI `--verbose` consumer + environment hints

**Files:**
- Modify: `apps/cli/src/args.ts` (add `verbose`)
- Modify: `apps/cli/src/args.test.ts` (assert verbose parse)
- Create: `apps/cli/src/diag-log.ts` (`formatDiagLine` + `attachDiagLog`)
- Create: `apps/cli/src/diag-log.test.ts`
- Modify: `apps/cli/src/cli.tsx` (parse verbose; `attachDiagLog` on all three client paths; multicast hint on LAN-join failure)

**Interfaces:**
- Consumes: `DiagEvent` from `@uniclip/client-core`; the `client.on("diag", …)` event surface.
- Produces:
  - `parseArgs` return type gains `verbose: boolean`.
  - `function formatDiagLine(elapsedMs: number, e: DiagEvent): string`
  - `function attachDiagLog(client: { on(k: "diag", cb: (e: DiagEvent) => void): void }, opts?: { now?: () => number; write?: (s: string) => void; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void }): void`

- [ ] **Step 1: Write the failing args test**

Add to `apps/cli/src/args.test.ts`:

```ts
it("parses --verbose and -V", () => {
  expect(parseArgs(["--verbose"]).verbose).toBe(true);
  expect(parseArgs(["-V"]).verbose).toBe(true);
  expect(parseArgs([]).verbose).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @uniclip/cli test args`
Expected: FAIL — `verbose` is not on the return type / undefined.

- [ ] **Step 3: Add `verbose` to `parseArgs`**

In `apps/cli/src/args.ts`: add to the return type signature `verbose: boolean`; add `let verbose = process.env.UNICLIP_VERBOSE ? true : false;`; add a branch `else if (a === "--verbose" || a === "-V") { verbose = true; }`; add `verbose,` to the returned object.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @uniclip/cli test args`
Expected: PASS.

- [ ] **Step 5: Write the failing diag-log formatter + hint tests**

Create `apps/cli/src/diag-log.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { formatDiagLine, attachDiagLog } from "./diag-log";
import type { DiagEvent } from "@uniclip/client-core";

const ev = (e: Partial<DiagEvent>): DiagEvent => ({ kind: "diag", phase: "ws", level: "info", detail: "x", ...e } as DiagEvent);

describe("formatDiagLine", () => {
  it("prefixes a relative timestamp, phase, and detail", () => {
    const line = formatDiagLine(12483, ev({ phase: "pc-state", detail: "connecting -> connected" }));
    expect(line).toContain("12.48s");
    expect(line).toContain("pc-state");
    expect(line).toContain("connecting -> connected");
  });
  it("marks warn and error levels", () => {
    expect(formatDiagLine(0, ev({ level: "warn", detail: "w" }))).toMatch(/!/);
    expect(formatDiagLine(0, ev({ level: "error", detail: "e" }))).toMatch(/✗|x/i);
  });
});

describe("attachDiagLog", () => {
  function fakeClient() {
    let cb: ((e: DiagEvent) => void) | undefined;
    return { on: (_k: string, f: (e: DiagEvent) => void) => (cb = f), emit: (e: DiagEvent) => cb?.(e) };
  }
  it("writes each diag event as a line to the writer", () => {
    const c = fakeClient();
    const out: string[] = [];
    attachDiagLog(c as any, { now: () => 1000, write: (s) => out.push(s) });
    c.emit(ev({ phase: "dc", detail: "open" }));
    expect(out.join("")).toContain("dc");
    expect(out.join("")).toContain("open");
  });
  it("warns when the relay never opens within the timeout", () => {
    const c = fakeClient();
    const out: string[] = [];
    const timers: Array<() => void> = [];
    attachDiagLog(c as any, { now: () => 0, write: (s) => out.push(s), setTimer: (fn) => { timers.push(fn); return 0; }, clearTimer: () => {} });
    c.emit(ev({ phase: "ws", detail: "connecting", data: { event: "connecting" } }));
    timers.forEach((fn) => fn()); // fire the 3s timer without an intervening "open"
    expect(out.join("")).toMatch(/relay unreachable/i);
  });
  it("does NOT warn relay-unreachable when open arrives first", () => {
    const c = fakeClient();
    const out: string[] = [];
    let cleared = false;
    attachDiagLog(c as any, { now: () => 0, write: (s) => out.push(s), setTimer: () => 1, clearTimer: () => { cleared = true; } });
    c.emit(ev({ phase: "ws", detail: "connecting", data: { event: "connecting" } }));
    c.emit(ev({ phase: "ws", detail: "open", data: { event: "open" } }));
    expect(cleared).toBe(true);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter @uniclip/cli test diag-log`
Expected: FAIL — module `./diag-log` missing.

- [ ] **Step 7: Implement `diag-log.ts`**

Create `apps/cli/src/diag-log.ts`:

```ts
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
      relayTimer = setTimer(() => hint(`relay unreachable — check network/URL (no WS open in ${RELAY_OPEN_MS / 1000}s)`), RELAY_OPEN_MS);
    }
    if (e.phase === "ws" && e.data?.event === "open") {
      clearTimer(relayTimer);
    }
    if (e.phase === "ice-candidate" && (e.data?.typ === "srflx" || e.data?.typ === "relay")) {
      sawTransit = true;
    }
    if (e.phase === "pc-state" && e.data?.state === "connecting") {
      p2pTimer = setTimer(() => {
        if (!sawTransit) hint("no STUN/relay candidates — P2P may be firewalled; will use relay");
      }, P2P_CONNECT_MS);
    }
    if (e.phase === "pc-state" && e.data?.state === "connected") {
      clearTimer(p2pTimer);
    }
  });
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `pnpm --filter @uniclip/cli test diag-log`
Expected: PASS.

- [ ] **Step 9: Wire `--verbose` into `cli.tsx`**

In `apps/cli/src/cli.tsx`:

Add imports:

```ts
import { attachDiagLog } from "./diag-log";
```

Destructure `verbose` from `parseArgs` (extend the existing destructure on line 30):

```ts
  const { roomUrl: arg, relay, name, relayOnly, lan, help, version, verbose } = parseArgs(process.argv.slice(2));
```

Attach the logger to each client right after it is created, before `render(...)`:
- LAN host path: after `const host = await startLanHost(...)` → `if (verbose) attachDiagLog(host.client as any);`
- LAN join path: after `joiner = await joinLan(...)` succeeds → `if (verbose) attachDiagLog(joiner.client as any);`
- Relay path: after `const client = makeClient(...)` → `if (verbose) attachDiagLog(client);`

Add the multicast hint in the LAN-join `catch` (after the two existing `console.error` lines, before `process.exit(1)`):

```ts
      if (verbose) console.error("[hint] ! mDNS found nothing — suspect guest/AP-isolation Wi-Fi blocking multicast.");
```

Add `--verbose` to the `USAGE` options block:

```ts
  -V, --verbose    print transport diagnostics to stderr (state machine + hints)
```

- [ ] **Step 10: Run the full CLI suite + typecheck**

Run: `pnpm --filter @uniclip/cli test && pnpm --filter @uniclip/cli typecheck`
Expected: PASS / no type errors. (Confirms the Ink TUI on stdout is undisturbed — diagnostics go to stderr.)

- [ ] **Step 11: Commit**

```bash
git add apps/cli/src/args.ts apps/cli/src/args.test.ts apps/cli/src/diag-log.ts \
        apps/cli/src/diag-log.test.ts apps/cli/src/cli.tsx
git commit -m "feat(cli): --verbose diag logger to stderr + environment hints

Subscribes to the client diag stream, stamps relative time, writes one
line per event to stderr (Ink TUI on stdout stays clean). Advisory hints:
relay-unreachable (no WS open in 3s), P2P-firewalled (no transit candidate
in 10s), and mDNS multicast-block on LAN-join failure.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Web debug overlay

**Files:**
- Create: `apps/web/src/lib/debug-overlay.ts` (pure logic: ring buffer, line format, copy text, toggle parse)
- Create: `apps/web/src/lib/debug-overlay.test.ts`
- Create: `apps/web/src/components/debug-overlay.svelte` (thin render shell)
- Modify: `apps/web/src/routes/room.svelte` (diag state + `c.on("diag")` + toggle + render)

**Interfaces:**
- Consumes: `DiagEvent` from `@uniclip/client-core`.
- Produces (pure module):
  - `interface DiagRow { phase: string; level: string; detail: string; t: number }`
  - `function pushDiag(buf: DiagRow[], row: DiagRow, cap?: number): DiagRow[]` (returns a new bounded array, oldest dropped past `cap`, default 200)
  - `function diagToText(rows: DiagRow[]): string` (plain text for the Copy button)
  - `function candidateCounts(rows: DiagRow[]): { host: number; srflx: number; relay: number }`
  - `function debugEnabled(search: string): boolean` (`?debug` present)

- [ ] **Step 1: Write the failing pure-logic tests**

Create `apps/web/src/lib/debug-overlay.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pushDiag, diagToText, candidateCounts, debugEnabled, type DiagRow } from "./debug-overlay";

const row = (p: Partial<DiagRow>): DiagRow => ({ phase: "ws", level: "info", detail: "x", t: 0, ...p });

describe("pushDiag", () => {
  it("appends and caps the ring, dropping oldest", () => {
    let buf: DiagRow[] = [];
    for (let i = 0; i < 205; i++) buf = pushDiag(buf, row({ detail: String(i) }), 200);
    expect(buf.length).toBe(200);
    expect(buf[0]!.detail).toBe("5"); // 0..4 dropped
    expect(buf[199]!.detail).toBe("204");
  });
});

describe("diagToText", () => {
  it("serializes rows to one line each with relative seconds", () => {
    const txt = diagToText([row({ t: 1500, phase: "dc", detail: "open" })]);
    expect(txt).toContain("1.50s");
    expect(txt).toContain("dc");
    expect(txt).toContain("open");
  });
});

describe("candidateCounts", () => {
  it("counts host/srflx/relay from ice-candidate detail", () => {
    const rows = [
      row({ phase: "ice-candidate", detail: "host udp" }),
      row({ phase: "ice-candidate", detail: "srflx udp" }),
      row({ phase: "ice-candidate", detail: "host tcp" }),
    ];
    expect(candidateCounts(rows)).toEqual({ host: 2, srflx: 1, relay: 0 });
  });
});

describe("debugEnabled", () => {
  it("is true when ?debug is present", () => {
    expect(debugEnabled("?debug")).toBe(true);
    expect(debugEnabled("?foo=1&debug")).toBe(true);
    expect(debugEnabled("?foo=1")).toBe(false);
    expect(debugEnabled("")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @uniclip/web test debug-overlay`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the pure module**

Create `apps/web/src/lib/debug-overlay.ts`:

```ts
// Pure logic for the debug overlay (tested in node). The .svelte shell renders
// these; keeping logic here matches the codebase's lib-tested pattern.
export interface DiagRow {
  phase: string;
  level: string;
  detail: string;
  t: number; // ms since session start
}

export function pushDiag(buf: DiagRow[], row: DiagRow, cap = 200): DiagRow[] {
  const next = buf.length >= cap ? buf.slice(buf.length - cap + 1) : buf.slice();
  next.push(row);
  return next;
}

export function diagToText(rows: DiagRow[]): string {
  return rows
    .map((r) => `[${(r.t / 1000).toFixed(2)}s] ${r.level === "info" ? "" : r.level.toUpperCase() + " "}${r.phase} ${r.detail}`)
    .join("\n");
}

export function candidateCounts(rows: DiagRow[]): { host: number; srflx: number; relay: number } {
  const c = { host: 0, srflx: 0, relay: 0 };
  for (const r of rows) {
    if (r.phase !== "ice-candidate") continue;
    if (r.detail.startsWith("host")) c.host++;
    else if (r.detail.startsWith("srflx")) c.srflx++;
    else if (r.detail.startsWith("relay")) c.relay++;
  }
  return c;
}

export function debugEnabled(search: string): boolean {
  const q = search.startsWith("?") ? search.slice(1) : search;
  return q.split("&").some((p) => p === "debug" || p.startsWith("debug="));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @uniclip/web test debug-overlay`
Expected: PASS.

- [ ] **Step 5: Create the overlay component shell**

Create `apps/web/src/components/debug-overlay.svelte`:

```svelte
<script lang="ts">
  import { diagToText, candidateCounts, type DiagRow } from "../lib/debug-overlay";

  let { rows = [], transport = "relay", onClose = () => {} }: {
    rows?: DiagRow[];
    transport?: "p2p" | "relay";
    onClose?: () => void;
  } = $props();

  let copied = $state(false);
  const counts = $derived(candidateCounts(rows));

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(diagToText(rows));
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch { /* clipboard denied — no-op */ }
  }

  function levelColor(level: string): string {
    return level === "error" ? "#f87171" : level === "warn" ? "#fbbf24" : "#9ca3af";
  }
</script>

<!-- plain rgba + -webkit- blur: mobile Safari (row B) renders bg-black/NN as transparent -->
<div
  style="position:fixed;right:8px;bottom:8px;width:min(92vw,440px);max-height:50vh;overflow:auto;
         background:rgba(15,15,18,0.92);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);
         color:#e5e7eb;font:11px ui-monospace,Menlo,monospace;border-radius:8px;padding:8px;z-index:9999;"
>
  <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;">
    <span>
      {transport === "p2p" ? "Direct" : "Relayed"}
      · host {counts.host} · srflx {counts.srflx} · relay {counts.relay}
    </span>
    <span style="display:flex;gap:6px;">
      <button onclick={copyAll} style="cursor:pointer;">{copied ? "Copied" : "Copy"}</button>
      <button onclick={onClose} style="cursor:pointer;">×</button>
    </span>
  </div>
  {#each rows as r (r.t + r.phase + r.detail)}
    <div style="white-space:pre;color:{levelColor(r.level)};">
      [{(r.t / 1000).toFixed(2)}s] {r.phase} {r.detail}
    </div>
  {/each}
</div>
```

- [ ] **Step 6: Wire the overlay into `room.svelte`**

In `apps/web/src/routes/room.svelte`:

Add imports (near the other component imports):

```ts
  import DebugOverlay from "../components/debug-overlay.svelte";
  import { pushDiag, debugEnabled, type DiagRow } from "../lib/debug-overlay";
```

Add state (near the other `$state` declarations, e.g. by `transport`):

```ts
  let diagRows = $state<DiagRow[]>([]);
  let showDebug = $state(debugEnabled(typeof location !== "undefined" ? location.search : ""));
  const diagStart = Date.now();
```

Subscribe to diag where the other `c.on(...)` handlers are registered (e.g. after the `c.on("transport", …)` line):

```ts
    c.on("diag", (e) => {
      diagRows = pushDiag(diagRows, { phase: e.phase, level: e.level, detail: e.detail, t: Date.now() - diagStart });
    });
```

Add the `?` key toggle. If the file already has a keydown handler, add a branch; otherwise add an effect:

```ts
  $effect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (ev.key === "?" && tag !== "INPUT" && tag !== "TEXTAREA") showDebug = !showDebug;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
```

Render the overlay at the end of the markup (top level of the template):

```svelte
{#if showDebug}
  <DebugOverlay rows={diagRows} {transport} onClose={() => (showDebug = false)} />
{/if}
```

- [ ] **Step 7: Verify typecheck + build (svelte-check catches mount/runes issues)**

Run: `pnpm --filter @uniclip/web typecheck`
Expected: no errors.
Run: `pnpm --filter @uniclip/web build`
Expected: build succeeds (the overlay compiles; `vite-plugin-svelte` v5 is already in place).

- [ ] **Step 8: Run the full web test suite**

Run: `pnpm --filter @uniclip/web test`
Expected: PASS (existing + debug-overlay lib tests).

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/lib/debug-overlay.ts apps/web/src/lib/debug-overlay.test.ts \
        apps/web/src/components/debug-overlay.svelte apps/web/src/routes/room.svelte
git commit -m "feat(web): debug overlay over the diag stream (?debug / ? key)

Bounded-ring diag rows with a host/srflx/relay summary + Direct/Relayed,
toggled by ?debug query (phone-friendly) or the ? key, with a Copy button
to paste a session trace back for triage. Pure logic in lib/ (tested);
plain rgba + -webkit- blur for mobile Safari.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Runbook tightening + result template

**Files:**
- Modify: `docs/cross-device-validation.md` (enabling-diagnostics section; per-row expected diag traces)
- Create: `docs/cross-device-validation-results-template.md` (blank fillable result doc)

No code, no tests — documentation. One commit.

- [ ] **Step 1: Add the "Enabling diagnostics" section to `docs/cross-device-validation.md`**

Insert after the "Setup options" section (before "## Matrix"):

```markdown
## Enabling diagnostics

Turn these on so a failure is attributable instead of a silent hang.

- **CLI (rows A, C, E, F, G):** add `--verbose` and redirect stderr to a file on *each* end —
  `uniclip --verbose 2> host-<row>.log` and `uniclip <token-or-url> --verbose 2> join-<row>.log`.
  Verbose prints the transport state machine (ICE candidate types, pc-state, datachannel, signaling,
  transport switch) plus advisory hints (relay unreachable, P2P firewalled, mDNS multicast blocked).
- **Web (row B / phone):** append `?debug` to the room URL in the address bar (or press `?` on desktop).
  A bottom-right overlay shows the same stream + a host/srflx/relay summary. Tap **Copy** to grab the
  trace as text and paste it into the result doc.

### How to read a trace
- **Direct (P2P) success:** `ice-candidate host` → `pc-state … connected` → `dc open` → `transport relay -> p2p`.
- **Relay fallback:** no `dc open`; `transport` stays `relay`. Clips still sync — note it as Relayed, not a failure.
- **Candidate types:** `host` = LAN/direct, `srflx` = STUN-reflexive (NAT punched), `relay` = TURN.
```

- [ ] **Step 2: Add per-row "expected trace" notes to the matrix**

In `docs/cross-device-validation.md`, append an "Expected trace" line to the Expected cell of rows A, B, C (edit the existing table cells):

- Row A: `… Expected diag: ice-candidate host → pc-state connected → dc open → transport p2p (Direct).`
- Row B: `… Expected diag: a srflx candidate then dc open (Direct), OR a clean transport=relay with no dc open (Relayed) — both are passes; record which.`
- Row C: `… Expected diag: host candidates ONLY (no srflx — proves no STUN/offline), yet dc open. Any srflx means internet wasn't actually cut.`

- [ ] **Step 3: Create the blank result template**

Create `docs/cross-device-validation-results-template.md`:

```markdown
# Cross-device validation — results (copy to cross-device-validation-results-YYYY-MM-DD.md)

Runbook: docs/cross-device-validation.md. Fill one block per row attempted.
Attach the per-end CLI logs (host-<row>.log / join-<row>.log) or pasted Web Copy text.

Environment: <macOS/Linux/Windows versions; Wi-Fi / hotspot / wired / VPN>

---

### Row A — LAN P2P, internet present
- Result: PASS / FAIL
- Path reached: Direct / Relayed
- OS + network:
- diag excerpt / attached log:
- Notes:

### Row B — NAT traversal, different networks
- Result: PASS / FAIL
- Path reached: Direct (srflx) / Relayed
- OS + network:
- diag excerpt / attached log:
- Notes:

### Row C — Zero-internet --lan ⭐
- Result: PASS / FAIL
- Path reached: Direct / Relayed
- Confirmed offline (no srflx): yes / no
- OS + network:
- diag excerpt / attached log:
- Notes:

### Row D — Large file transfer (web)
- Result: PASS / FAIL
- Size + integrity (hash matched): 
- Notes:

### Row E — Reconnect resilience
- Result: PASS / FAIL
- Queued-then-flushed: yes / no · P2P re-established: yes / no
- Notes:

### Row F — Multi-peer presence
- Result: PASS / FAIL
- Roster correct on join/leave: yes / no
- Notes:

### Row G — Cross-platform
- Result: PASS / FAIL
- OS pair:
- Notes:

### Row H — Wrong-network negative
- Result: PASS / FAIL
- Friendly timeout (no hang/crash): yes / no
- Notes:

---

## Summary
- Rows passed: __ / 8
- FAIL rows → open a systematic-debugging cycle each (small: fix directly; large: new spec).
```

- [ ] **Step 4: Commit**

```bash
git add docs/cross-device-validation.md docs/cross-device-validation-results-template.md
git commit -m "docs: cross-device runbook — enabling diagnostics + result template

Adds an enabling-diagnostics section (CLI --verbose 2> file, Web ?debug +
Copy), per-row expected diag traces for A/B/C, and a blank fillable result
template to copy per run. Tooling-only phase; FAIL rows triaged separately.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] `pnpm typecheck` — all packages clean.
- [ ] `pnpm test` — all suites pass (client-core diag, cli args/diag-log, web debug-overlay; relay untouched).
- [ ] Manual sanity: `pnpm --filter @uniclip/cli dev --verbose` against a local relay prints diag lines to stderr; the Ink TUI on stdout is unaffected.
- [ ] Whole-branch review (opus) before merge: confirm no transport-behavior change, the decrypt-fail privacy lock holds, diagnostics are off by default, and consumers match on `data` not `detail`.
- [ ] After merge: the human runs `docs/cross-device-validation.md` on real hardware (two Macs / Mac+Linux / Mac+phone) and fills a results doc. Each FAIL row becomes its own systematic-debugging cycle — **not** part of this plan.
```

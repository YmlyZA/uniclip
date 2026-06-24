# CLI TUI (P4a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new `apps/cli` — a modern Ink/React terminal UI that creates or joins a Mode-A room and syncs text clips over the relay (same E2EE as the web), reusing `client-core`.

**Architecture:** A Node ESM app built with tsup. `client-core`'s `UniclipClient` is used verbatim over the global `WebSocket`, with P2P disabled via a never-opening `createConnection` stub (relay-only). Ink renders a header / scrollable clip list / input / footer; selecting a clip copies it to the OS clipboard. No protocol/relay/crypto change; no persistence.

**Tech Stack:** TypeScript, Node ≥22, Ink 5 (React 18, ESM), `ink-text-input`, `clipboardy`, `qrcode`, tsup, vitest + `ink-testing-library`.

## Global Constraints

- **TDD always:** failing test → red → minimal impl → green → commit. (`CLAUDE.md`.)
- **New app `apps/cli`; no change to `packages/*`, `apps/relay`, or `apps/web`.** No protocol/relay/crypto change — the CLI is a new `client-core` consumer.
- **Mode A only.** Secret from `generateModeARoom().secret` (client-side); only `routingId` reaches the relay; same envelope/AAD via `client-core`. **No persistence** (in-memory session history). **No P2P** (inject the disabled-peer stub). **No files** (text only).
- **Toolchain reality:** Ink 5 is **ESM-only** and needs **React 18**; the package is `"type": "module"`. tsup outputs ESM with a `#!/usr/bin/env node` shebang. Tests run under Node vitest (Ink renders to a string — no jsdom/pty); ensure vitest transforms `.tsx` (tsconfig `jsx: "react-jsx"` + esbuild automatic JSX). **Align the `vitest` version with the workspace's existing one** (check another package's devDeps) to avoid a second copy. If the Ink 5 / ESM / vitest toolchain cannot be made to run in Task 1, report BLOCKED with the exact error rather than fighting it silently.
- **Text cap:** the CLI defines its own `MAX_TEXT_BYTES = 32 * 1024` (the web's lives in `apps/web`, not a shared package); aligned with `@uniclip/protocol`'s `MAX_FRAME_BYTES`.
- **Relay base:** `--relay`/`UNICLIP_RELAY` (default `http://localhost:3000`) for create; derived from the room-URL origin for join (`http→ws`, `https→wss`).
- **Spec:** `docs/superpowers/specs/2026-06-24-uniclip-cli-tui-design.md`.
- **Commit style:** small, scoped; end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Branch: `feat/cli-tui`.

---

## File Structure

- `apps/cli/package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts` — package + toolchain.
- `apps/cli/src/cli.tsx` — bin entry: argv parsing, create-vs-join, `render(<App/>)`.
- `apps/cli/src/session.ts` — `relayBaseFromUrl`, `createRoom`, `makeClient`.
- `apps/cli/src/disabled-peer.ts` — the never-opening `createConnection` stub.
- `apps/cli/src/qr.ts` — `asciiQr`.
- `apps/cli/src/clipboard.ts` — `copyToClipboard`.
- `apps/cli/src/components/{Header,ClipList,Composer,PairScreen,Footer}.tsx` — presentational.
- `apps/cli/src/app.tsx` — `<App>` (client wiring + keybindings).
- `apps/cli/src/*.test.ts(x)` — unit/component tests.

---

## Task 1: Scaffold `apps/cli` + prove the toolchain

**Files:**
- Create: `apps/cli/package.json`, `apps/cli/tsconfig.json`, `apps/cli/tsup.config.ts`, `apps/cli/vitest.config.ts`, `apps/cli/src/smoke.tsx`, `apps/cli/src/smoke.test.tsx`

**Interfaces:**
- Produces: a buildable/test-runnable `@uniclip/cli` package; `Smoke` component proving Ink + vitest + ink-testing-library work.

- [ ] **Step 1: Create the package manifest**

`apps/cli/package.json` (align the `vitest` version with the workspace — check `apps/web/package.json` devDeps and match its major):

```json
{
  "name": "@uniclip/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "uniclip": "./dist/cli.js" },
  "scripts": {
    "dev": "tsx src/cli.tsx",
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "eslint ."
  },
  "dependencies": {
    "@uniclip/client-core": "workspace:*",
    "@uniclip/protocol": "workspace:*",
    "@uniclip/room-code": "workspace:*",
    "clipboardy": "^4.0.0",
    "ink": "^5.0.1",
    "ink-text-input": "^6.0.0",
    "qrcode": "^1.5.4",
    "react": "^18.3.1"
  },
  "devDependencies": {
    "@types/qrcode": "^1.5.5",
    "@types/react": "^18.3.3",
    "@uniclip/tsconfig": "workspace:*",
    "ink-testing-library": "^4.0.0",
    "tsup": "^8.3.0",
    "tsx": "^4.19.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: tsconfig + tsup + vitest config**

`apps/cli/tsconfig.json`:
```json
{
  "extends": "@uniclip/tsconfig/base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023", "DOM"],
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src"]
}
```
> `lib` includes `DOM` only for the `RTCPeerConnection`/`WebSocket` type names `client-core` references; the runtime uses Node globals. If `@uniclip/tsconfig/base.json` already sets these, keep this override minimal — confirm the extends path matches the other packages' tsconfigs.

`apps/cli/tsup.config.ts`:
```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.tsx"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
  // Bundle the workspace TS deps; keep heavy native/ESM deps external.
  noExternal: [/@uniclip\//],
});
```

`apps/cli/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node" },
  esbuild: { jsx: "automatic" },
});
```

- [ ] **Step 3: Write the smoke component + test**

`apps/cli/src/smoke.tsx`:
```tsx
import { Text } from "ink";
export function Smoke() {
  return <Text>uniclip ready</Text>;
}
```

`apps/cli/src/smoke.test.tsx`:
```tsx
import { expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Smoke } from "./smoke";

it("renders with Ink + ink-testing-library", () => {
  const { lastFrame } = render(<Smoke />);
  expect(lastFrame()).toContain("uniclip ready");
});
```

- [ ] **Step 4: Install + verify the toolchain**

Run: `pnpm install` (from repo root, to link the new workspace package).
Run: `pnpm --filter @uniclip/cli test` → the smoke test PASSES.
Run: `pnpm --filter @uniclip/cli typecheck` → clean.
Expected: Ink renders, vitest transforms `.tsx`, types resolve. **If any of these fail due to ESM/Ink-version/vitest incompatibility, STOP and report BLOCKED with the exact error** (do not downgrade silently).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/package.json apps/cli/tsconfig.json apps/cli/tsup.config.ts apps/cli/vitest.config.ts apps/cli/src/smoke.tsx apps/cli/src/smoke.test.tsx pnpm-lock.yaml
git commit -m "feat(cli): scaffold apps/cli (Ink + tsup + vitest) with a smoke test

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `session.ts` + `disabled-peer.ts`

**Files:**
- Create: `apps/cli/src/disabled-peer.ts`, `apps/cli/src/session.ts`
- Test: `apps/cli/src/session.test.ts`

**Interfaces:**
- Produces: `disabledPeer: (config?: RTCConfiguration) => RTCPeerConnection`; `relayBaseFromUrl(roomUrl: string): string`; `createRoom(relayBase: string, fetchImpl?: typeof fetch): Promise<{ roomUrl: string }>`; `makeClient(opts: { roomUrl: string; deviceName?: string }): UniclipClient`.

- [ ] **Step 1: Write the failing test**

`apps/cli/src/session.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { relayBaseFromUrl, createRoom } from "./session";
import { disabledPeer } from "./disabled-peer";

describe("relayBaseFromUrl", () => {
  it("maps https→wss and http→ws, preserving host/port", () => {
    expect(relayBaseFromUrl("https://uniclip.app/r/abc123#sekretsekretsekret")).toBe("wss://uniclip.app");
    expect(relayBaseFromUrl("http://localhost:3000/r/abc123#sekretsekretsekret")).toBe("ws://localhost:3000");
  });
});

describe("createRoom", () => {
  it("POSTs {mode:'A'} and forms /r/<roomId>#<secret>", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ roomId: "abc123" }) })) as unknown as typeof fetch;
    const { roomUrl } = await createRoom("http://localhost:3000", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:3000/api/room",
      expect.objectContaining({ method: "POST" }),
    );
    expect(roomUrl).toMatch(/^http:\/\/localhost:3000\/r\/abc123#[0-9A-Za-z]{18}$/);
  });
  it("throws on a non-ok response", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 429 })) as unknown as typeof fetch;
    await expect(createRoom("http://localhost:3000", fetchImpl)).rejects.toThrow(/429/);
  });
});

describe("disabledPeer", () => {
  it("returns a connection whose data channel never opens", () => {
    const pc = disabledPeer();
    const ch = pc.createDataChannel("uniclip");
    expect(ch.readyState).toBe("connecting"); // never 'open'
    expect(() => ch.send("x")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @uniclip/cli test session`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

`apps/cli/src/disabled-peer.ts`:
```ts
// A fake RTCPeerConnection whose data channel never opens, so UniclipClient
// stays on the relay (Node has no RTCPeerConnection; P2P/zero-internet is P4b).
export const disabledPeer = (): RTCPeerConnection =>
  ({
    onicecandidate: null, ondatachannel: null, onnegotiationneeded: null,
    onconnectionstatechange: null, signalingState: "stable", connectionState: "new",
    localDescription: null,
    createDataChannel: () => ({
      readyState: "connecting", send() {}, close() {},
      onopen: null, onclose: null, onmessage: null,
    }),
    createOffer: async () => ({ type: "offer", sdp: "" }),
    createAnswer: async () => ({ type: "answer", sdp: "" }),
    setLocalDescription: async () => {}, setRemoteDescription: async () => {},
    addIceCandidate: async () => {}, close() {},
  }) as unknown as RTCPeerConnection;
```

`apps/cli/src/session.ts`:
```ts
import { UniclipClient } from "@uniclip/client-core";
import { generateModeARoom } from "@uniclip/room-code";
import { disabledPeer } from "./disabled-peer";

// Room URL (http/https origin) → the ws(s) base UniclipClient connects to.
export function relayBaseFromUrl(roomUrl: string): string {
  const u = new URL(roomUrl);
  const ws = u.protocol === "https:" ? "wss:" : "ws:";
  return `${ws}//${u.host}`;
}

// Mint a Mode-A room on the relay and form its share URL (secret client-side).
export async function createRoom(
  relayBase: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ roomUrl: string }> {
  const base = relayBase.replace(/\/$/, "");
  const res = await fetchImpl(`${base}/api/room`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "A" }),
  });
  if (!res.ok) throw new Error(`room creation failed: ${res.status}`);
  const { roomId } = (await res.json()) as { roomId: string };
  const { secret } = generateModeARoom();
  return { roomUrl: `${base}/r/${roomId}#${secret}` };
}

// Build a relay-only UniclipClient (P2P disabled).
export function makeClient(opts: { roomUrl: string; deviceName?: string }): UniclipClient {
  return new UniclipClient({
    roomUrl: opts.roomUrl,
    relayBase: relayBaseFromUrl(opts.roomUrl),
    createConnection: disabledPeer,
    ...(opts.deviceName ? { deviceName: opts.deviceName } : {}),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @uniclip/cli test session` → PASS. `pnpm --filter @uniclip/cli typecheck` → clean.

> If `generateModeARoom().secret` does not match `[0-9A-Za-z]{18}`, adjust the test's regex to `MODE_A_SECRET_ALPHABET`/`MODE_A_SECRET_LEN` from `@uniclip/room-code` (import the consts and build the expected character class) — the secret shape is the source of truth, not the regex.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/disabled-peer.ts apps/cli/src/session.ts apps/cli/src/session.test.ts
git commit -m "feat(cli): session helpers — relay base, room creation, relay-only client

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `qr.ts` + `clipboard.ts`

**Files:**
- Create: `apps/cli/src/qr.ts`, `apps/cli/src/clipboard.ts`
- Test: `apps/cli/src/qr.test.ts`, `apps/cli/src/clipboard.test.ts`

**Interfaces:**
- Produces: `asciiQr(text: string): Promise<string>`; `copyToClipboard(text: string, writer?: (t: string) => Promise<void>): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

`apps/cli/src/qr.test.ts`:
```ts
import { expect, it } from "vitest";
import { asciiQr } from "./qr";

it("renders a non-empty UTF-8 QR block for a URL", async () => {
  const out = await asciiQr("https://uniclip.app/r/abc123#sekretsekretsekret");
  expect(out.length).toBeGreaterThan(0);
  expect(out).toMatch(/[█▀▄ ]/); // contains block/half-block glyphs
});
```

`apps/cli/src/clipboard.test.ts`:
```ts
import { expect, it, vi } from "vitest";
import { copyToClipboard } from "./clipboard";

it("writes via the injected writer and returns true", async () => {
  const writer = vi.fn(async () => {});
  expect(await copyToClipboard("hello", writer)).toBe(true);
  expect(writer).toHaveBeenCalledWith("hello");
});
it("returns false (no throw) when the writer fails", async () => {
  const writer = vi.fn(async () => { throw new Error("no clipboard"); });
  expect(await copyToClipboard("hello", writer)).toBe(false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @uniclip/cli test qr clipboard`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

`apps/cli/src/qr.ts`:
```ts
import QRCode from "qrcode";

// A compact UTF-8 QR suitable for a terminal; `small` uses half-block glyphs.
export function asciiQr(text: string): Promise<string> {
  return QRCode.toString(text, { type: "utf8", small: true });
}
```

`apps/cli/src/clipboard.ts`:
```ts
import clipboard from "clipboardy";

// Writes to the OS clipboard. Never throws — a failure (no clipboard tool on
// the host) returns false so the UI can show a transient message.
export async function copyToClipboard(
  text: string,
  writer: (t: string) => Promise<void> = clipboard.write,
): Promise<boolean> {
  try {
    await writer(text);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @uniclip/cli test qr clipboard` → PASS. `pnpm --filter @uniclip/cli typecheck` → clean.

> `clipboard.write` is a bound method; if passing `clipboard.write` as a default loses `this`, change the default to `(t) => clipboard.write(t)`. The injected-writer tests don't exercise the real default, so this only matters at runtime — verify with `pnpm --filter @uniclip/cli build` later.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/qr.ts apps/cli/src/clipboard.ts apps/cli/src/qr.test.ts apps/cli/src/clipboard.test.ts
git commit -m "feat(cli): qr (ascii) + clipboard (cross-platform copy) helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Presentational components

**Files:**
- Create: `apps/cli/src/components/Header.tsx`, `ClipList.tsx`, `Composer.tsx`, `PairScreen.tsx`, `Footer.tsx`
- Test: `apps/cli/src/components/components.test.tsx`

**Interfaces:**
- Produces (props):
  - `Header({ routingId: string; status: string; peerCount: number })`
  - `ClipList({ items: { id: string; text: string; ts: number; mine: boolean }[]; selected: number })`
  - `Composer({ value: string; onChange: (v: string) => void; onSubmit: () => void; over: boolean })`
  - `PairScreen({ roomUrl: string; qr: string })`
  - `Footer()`

- [ ] **Step 1: Write the failing tests**

`apps/cli/src/components/components.test.tsx`:
```tsx
import { expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Header } from "./Header";
import { ClipList } from "./ClipList";
import { PairScreen } from "./PairScreen";

it("Header shows routingId, Mode A, status and peer count", () => {
  const { lastFrame } = render(<Header routingId="abc123" status="secure channel" peerCount={2} />);
  const f = lastFrame()!;
  expect(f).toContain("abc123");
  expect(f).toContain("Mode A");
  expect(f).toContain("secure channel");
  expect(f).toContain("2");
});

it("ClipList renders rows and marks the selected one", () => {
  const items = [
    { id: "1", text: "first", ts: 1, mine: true },
    { id: "2", text: "second", ts: 2, mine: false },
  ];
  const { lastFrame } = render(<ClipList items={items} selected={1} />);
  const f = lastFrame()!;
  expect(f).toContain("first");
  expect(f).toContain("second");
  expect(f).toMatch(/[>›❯].*second/); // a cursor marks the selected row
});

it("PairScreen shows the URL and the QR block", () => {
  const { lastFrame } = render(<PairScreen roomUrl="http://h/r/abc123#sek" qr={"█ █\n ██"} />);
  const f = lastFrame()!;
  expect(f).toContain("abc123");
  expect(f).toContain("█");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @uniclip/cli test components`
Expected: FAIL — components missing.

- [ ] **Step 3: Implement the components**

`apps/cli/src/components/Header.tsx`:
```tsx
import { Box, Text } from "ink";
export function Header({ routingId, status, peerCount }: { routingId: string; status: string; peerCount: number }) {
  return (
    <Box justifyContent="space-between" borderStyle="round" paddingX={1}>
      <Text>uniclip · <Text color="cyan">{routingId}</Text> · Mode A</Text>
      <Text color={status === "secure channel" ? "green" : "yellow"}>{status} · {peerCount} {peerCount === 1 ? "device" : "devices"}</Text>
    </Box>
  );
}
```

`apps/cli/src/components/ClipList.tsx`:
```tsx
import { Box, Text } from "ink";
type Item = { id: string; text: string; ts: number; mine: boolean };
export function ClipList({ items, selected }: { items: Item[]; selected: number }) {
  if (items.length === 0) return <Box paddingY={1}><Text dimColor>No clips yet — type below to send.</Text></Box>;
  return (
    <Box flexDirection="column" paddingY={1}>
      {items.map((it, i) => (
        <Box key={it.id}>
          <Text color={i === selected ? "cyan" : undefined}>{i === selected ? "❯ " : "  "}</Text>
          <Text dimColor>{it.mine ? "you" : "peer"} </Text>
          <Text wrap="truncate-end">{it.text}</Text>
        </Box>
      ))}
    </Box>
  );
}
```

`apps/cli/src/components/Composer.tsx`:
```tsx
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
export function Composer({ value, onChange, onSubmit, over }: { value: string; onChange: (v: string) => void; onSubmit: () => void; over: boolean }) {
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" paddingX={1}>
        <Text color="cyan">› </Text>
        <TextInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder="Type and press Enter to send" />
      </Box>
      {over && <Text color="red">Too large to send (max 32 KB).</Text>}
    </Box>
  );
}
```

`apps/cli/src/components/PairScreen.tsx`:
```tsx
import { Box, Text } from "ink";
export function PairScreen({ roomUrl, qr }: { roomUrl: string; qr: string }) {
  return (
    <Box flexDirection="column" alignItems="center" paddingY={1}>
      <Text bold>Scan to pair, or open this link on another device:</Text>
      <Text color="cyan">{roomUrl}</Text>
      <Box marginTop={1}><Text>{qr}</Text></Box>
      <Text dimColor>Waiting for another device…</Text>
    </Box>
  );
}
```

`apps/cli/src/components/Footer.tsx`:
```tsx
import { Box, Text } from "ink";
export function Footer() {
  return (
    <Box paddingX={1}>
      <Text dimColor>↑↓ select · c/⏎ copy · esc compose · q quit</Text>
    </Box>
  );
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @uniclip/cli test components` → PASS. `pnpm --filter @uniclip/cli typecheck` → clean.

> If `ink-text-input`'s default export differs (named vs default) for the installed version, adjust the import accordingly; the prop set (`value`/`onChange`/`onSubmit`/`placeholder`) is stable across v5/v6.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/components
git commit -m "feat(cli): Ink presentational components (header, list, composer, pair, footer)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `<App>` — client wiring + keybindings

**Files:**
- Create: `apps/cli/src/app.tsx`
- Test: `apps/cli/src/app.test.tsx`

**Interfaces:**
- Consumes: the components (Task 4); `copyToClipboard` (Task 3); a `UniclipClient`-shaped object.
- Produces: `App({ client, roomUrl, qr, onExit, copy? })` where `client` is an injected object with `on(kind, cb)`, `connect()`, `send(text)`, `disconnect()` (so tests pass a fake); `copy` defaults to `copyToClipboard` (injectable).

- [ ] **Step 1: Write the failing test**

`apps/cli/src/app.test.tsx`:
```tsx
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "./app";

// Minimal fake UniclipClient: capture handlers, let the test drive events.
function fakeClient() {
  const handlers: Record<string, Function[]> = {};
  return {
    on: (k: string, cb: Function) => ((handlers[k] ||= []).push(cb)),
    emit: (k: string, ...a: unknown[]) => (handlers[k] || []).forEach((f) => f(...a)),
    connect: vi.fn(async () => {}),
    send: vi.fn(async () => ({ msgId: "x", ts: 1, queued: false })),
    disconnect: vi.fn(),
  };
}

describe("App", () => {
  it("appends a clip row when the client emits 'clip'", async () => {
    const client = fakeClient();
    const { lastFrame } = render(<App client={client as any} roomUrl="http://h/r/abc123#sek" qr="" onExit={() => {}} />);
    client.emit("clip", "hello from peer", 123, "m1");
    await Promise.resolve();
    expect(lastFrame()).toContain("hello from peer");
  });

  it("copies the selected clip to the clipboard on 'c'", async () => {
    const client = fakeClient();
    const copy = vi.fn(async () => true);
    const { stdin, lastFrame } = render(<App client={client as any} roomUrl="http://h/r/abc123#sek" qr="" onExit={() => {}} copy={copy} />);
    client.emit("clip", "copy me", 1, "m1");
    await Promise.resolve();
    stdin.write("\u001B"); // Esc → switch from composing to list-navigation
    stdin.write("c");           // copy selected
    await Promise.resolve();
    expect(copy).toHaveBeenCalledWith("copy me");
  });

  it("connects on mount", () => {
    const client = fakeClient();
    render(<App client={client as any} roomUrl="http://h/r/abc123#sek" qr="" onExit={() => {}} />);
    expect(client.connect).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @uniclip/cli test app`
Expected: FAIL — `App` missing.

- [ ] **Step 3: Implement `<App>`**

`apps/cli/src/app.tsx`:
```tsx
import { useEffect, useState } from "react";
import { Box, useApp, useInput } from "ink";
import { Header } from "./components/Header";
import { ClipList } from "./components/ClipList";
import { Composer } from "./components/Composer";
import { PairScreen } from "./components/PairScreen";
import { Footer } from "./components/Footer";
import { copyToClipboard } from "./clipboard";

const MAX_TEXT_BYTES = 32 * 1024;

type Item = { id: string; text: string; ts: number; mine: boolean };
type ClientLike = {
  on: (k: string, cb: (...a: any[]) => void) => void;
  connect: () => Promise<void> | void;
  send: (t: string) => Promise<unknown> | unknown;
  disconnect: () => void;
};

export function App({
  client, roomUrl, qr, onExit, copy = copyToClipboard,
}: {
  client: ClientLike; roomUrl: string; qr: string; onExit: () => void;
  copy?: (t: string) => Promise<boolean>;
}) {
  const app = useApp();
  const routingId = (() => { try { return new URL(roomUrl).pathname.split("/r/")[1] ?? "?"; } catch { return "?"; } })();
  const [items, setItems] = useState<Item[]>([]);
  const [status, setStatus] = useState("connecting");
  const [peerCount, setPeerCount] = useState(1);
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState(0);
  const [composing, setComposing] = useState(true);
  const [note, setNote] = useState("");

  useEffect(() => {
    client.on("status", (s: string) => setStatus(s === "connected" ? "secure channel" : s));
    client.on("transport", (t: string) => setStatus(t === "p2p" ? "direct" : "secure channel"));
    client.on("peer", (n: number) => setPeerCount(n));
    client.on("clip", (text: string, ts: number, msgId: string) =>
      setItems((prev) => [...prev, { id: msgId, text, ts, mine: false }]),
    );
    client.on("error", (e: { message: string }) => setNote(e.message));
    void client.connect();
    return () => client.disconnect();
  }, [client]);

  const over = Buffer.byteLength(input, "utf8") > MAX_TEXT_BYTES;

  function send() {
    const text = input.trim();
    if (!text || over) return;
    const msgId = `local-${Date.now()}-${items.length}`;
    setItems((prev) => [...prev, { id: msgId, text, ts: Date.now(), mine: true }]);
    void client.send(text);
    setInput("");
  }

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") { onExit(); app.exit(); return; }
    if (composing) {
      if (key.escape) setComposing(false);
      return; // TextInput handles typing
    }
    // list-navigation mode
    if (ch === "q") { onExit(); app.exit(); return; }
    if (key.escape) { setComposing(true); return; }
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(items.length - 1, s + 1));
    if (ch === "c" || key.return) {
      const it = items[selected];
      if (it) void copy(it.text).then((ok) => setNote(ok ? "Copied to clipboard" : "Clipboard unavailable"));
    }
  });

  const paired = peerCount >= 2 || items.length > 0;

  return (
    <Box flexDirection="column">
      <Header routingId={routingId} status={status} peerCount={peerCount} />
      {!paired ? <PairScreen roomUrl={roomUrl} qr={qr} /> : <ClipList items={items} selected={selected} />}
      <Composer value={input} onChange={setInput} onSubmit={send} over={over} />
      {note ? <Box paddingX={1}><Footer /></Box> : <Footer />}
    </Box>
  );
}
```
> The `note` line is shown via state; if you prefer, render `{note && <Text dimColor>{note}</Text>}` above the footer. Keep the footer always visible. Adjust the focus model (`composing` flag) if the installed `ink-text-input` swallows the keys you need — the test drives `esc` then `c`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @uniclip/cli test app` → PASS. Then the full package: `pnpm --filter @uniclip/cli test` and `pnpm --filter @uniclip/cli typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/app.tsx apps/cli/src/app.test.tsx
git commit -m "feat(cli): App — wire UniclipClient to the TUI; select + copy keybindings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `cli.tsx` bin — argv, create-vs-join, render

**Files:**
- Create: `apps/cli/src/cli.tsx`
- Test: `apps/cli/src/args.test.ts` (parse helper extracted for testability)

**Interfaces:**
- Consumes: `createRoom`/`makeClient` (Task 2), `asciiQr` (Task 3), `<App>` (Task 5).
- Produces: `parseArgs(argv: string[]): { roomUrl?: string; relay: string; name?: string }`.

- [ ] **Step 1: Write the failing test (the pure arg parser)**

`apps/cli/src/args.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli";

describe("parseArgs", () => {
  it("defaults relay and takes a positional room url", () => {
    expect(parseArgs(["https://h/r/abc#sek"])).toEqual({ roomUrl: "https://h/r/abc#sek", relay: "http://localhost:3000" });
  });
  it("reads --relay and --name", () => {
    const a = parseArgs(["--relay", "https://relay.example", "--name", "Laptop"]);
    expect(a.relay).toBe("https://relay.example");
    expect(a.name).toBe("Laptop");
    expect(a.roomUrl).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @uniclip/cli test args`
Expected: FAIL — `parseArgs` not exported.

- [ ] **Step 3: Implement the bin**

`apps/cli/src/cli.tsx`:
```tsx
import { render } from "ink";
import { parseRoomUrl } from "@uniclip/room-code";
import { App } from "./app";
import { createRoom, makeClient } from "./session";
import { asciiQr } from "./qr";

export function parseArgs(argv: string[]): { roomUrl?: string; relay: string; name?: string } {
  let roomUrl: string | undefined;
  let relay = process.env.UNICLIP_RELAY ?? "http://localhost:3000";
  let name: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--relay") relay = argv[++i] ?? relay;
    else if (a === "--name") name = argv[++i];
    else if (!a.startsWith("-")) roomUrl = a;
  }
  return roomUrl ? { roomUrl, relay, name } : { relay, name };
}

async function main() {
  const { roomUrl: arg, relay, name } = parseArgs(process.argv.slice(2));
  let roomUrl: string;
  if (arg) {
    if (!parseRoomUrl(arg)) {
      console.error("Invalid room URL. Expected https://host/r/<id>#<secret>");
      process.exit(1);
    }
    roomUrl = arg;
  } else {
    try {
      ({ roomUrl } = await createRoom(relay));
    } catch (e) {
      console.error(`Could not create a room on ${relay}: ${(e as Error).message}`);
      process.exit(1);
    }
  }
  const qr = await asciiQr(roomUrl);
  const client = makeClient({ roomUrl, ...(name ? { deviceName: name } : {}) });
  const { waitUntilExit } = render(<App client={client as any} roomUrl={roomUrl} qr={qr} onExit={() => client.disconnect()} />);
  await waitUntilExit();
}

// Only run when executed as the bin (not when imported by tests).
if (process.argv[1] && /cli\.(tsx|js)$/.test(process.argv[1])) {
  void main();
}
```
> The `import.meta`/argv guard prevents `main()` from running during the `args.test.ts` import. If the guard is unreliable under tsup's bundling, move `parseArgs` to its own `args.ts` module and have `cli.tsx` import it — then the test imports `args.ts` and never triggers `main()`. Prefer that split if in doubt.

- [ ] **Step 4: Run tests + build**

Run: `pnpm --filter @uniclip/cli test` → all pass. `pnpm --filter @uniclip/cli typecheck` → clean.
Run: `pnpm --filter @uniclip/cli build` → produces `dist/cli.js` with a shebang. Sanity: `node apps/cli/dist/cli.js --help`-style smoke is not required, but `head -1 apps/cli/dist/cli.js` should show `#!/usr/bin/env node`.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/cli.tsx apps/cli/src/args.test.ts
git commit -m "feat(cli): bin entry — argv parsing, create/join, render the TUI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] `pnpm typecheck` → clean across all packages (now incl. `@uniclip/cli`).
- [ ] `pnpm test` → all unit suites green (cli: smoke + session + qr + clipboard + components + app + args).
- [ ] `pnpm --filter @uniclip/cli build` → `dist/cli.js` with shebang.
- [ ] Manual smoke (optional, needs a running relay): `PORT=3000 pnpm --filter @uniclip/relay dev` then `node apps/cli/dist/cli.js` → pair screen with URL+QR; open the URL in the web app → the CLI shows the clip list; type in the CLI → appears in the web; copy in the CLI → lands on the OS clipboard.
- [ ] Update `CLAUDE.md`: add an `apps/cli` bullet (Ink TUI, relay-only/Mode-A, reuses client-core, P2P disabled via stub) and note the new `apps/cli` workspace entry; mention `pnpm --filter @uniclip/cli dev`. (Fold into the Task 6 commit or a final `docs:` commit.)

## Spec coverage check (self-review)

- §2 (package/toolchain) → Task 1. §3 (entry & pairing, create/join, relay base) → Task 2 (`session`) + Task 6 (`cli.tsx`). §4 (TUI layout/components + keybindings + 32 KB cap) → Tasks 4 + 5. §5 (client reuse + P2P-disable stub) → Task 2 (`disabled-peer`) + Task 5 (wiring). §6 (clipboard + QR) → Task 3. §7 (security: Mode-A secret client-side, no persistence) → Task 2 (`createRoom`) + Task 5 (in-memory state). §8 (testing: session/components/app, no pty e2e) → each task's tests. §9 (decomposition) → the six tasks.

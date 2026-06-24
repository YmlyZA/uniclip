# Uniclip — CLI TUI (P4a, relay-connected) — Design Spec

**Date:** 2026-06-24
**Status:** Approved (pending spec review)
**Scope:** A new `apps/cli` — a modern interactive **terminal UI** (Ink/React on Node) that joins or creates a room and syncs **text** clips over the relay with the same E2EE as the web app, reusing `client-core` verbatim. **Relay-connected, text-only, no P2P/offline** (that is **P4b — zero-internet**, a separate spec). No protocol/relay/crypto change; a new consumer only.

## 1. Goals and non-goals

### Goals
1. `uniclip` launches a full-screen TUI: header (room/mode/status/peers), a scrollable clip history, an input line (type + Enter → send), a keybinding footer.
2. Pairing: with no argument, **mint a Mode-A room** (POST the relay) and show the share URL + an **ASCII QR**; with a room-URL argument, **join** it.
3. Select a clip (`↑`/`↓`) and **copy it to the OS clipboard** (cross-platform).
4. Reuse `client-core` (`UniclipClient`) over the global `WebSocket`; identical Mode-A zero-knowledge E2EE.

### Non-goals / preserved invariants
- **No P2P / no zero-internet** — P4a is relay-only; P4b adds Node WebRTC + mDNS + local signaling.
- **No files** — text clips only (file engine deferred).
- **No persistence** — session-only in-memory history (use-and-discard; nothing written to disk).
- **No protocol/relay/crypto change** — the CLI is purely a new client. Mode-A secret is generated client-side (`generateModeARoom().secret`); only `routingId` reaches the relay; same envelope/AAD.
- **No Mode B** in the CLI v1 (Mode A only — zero-knowledge by default).

## 2. Package & toolchain (`apps/cli`)

- **Runtime:** Node ≥ 22 (repo `engines`), which provides global `WebSocket` + WebCrypto that `client-core` needs.
- **Stack:** TypeScript + **Ink** (React renderer for the terminal) + `ink-text-input`. JSX via `tsconfig` `"jsx": "react-jsx"`.
- **Build:** **tsup** bundles `src/cli.tsx` (+ the workspace TS deps + JSX) into `dist/cli.js` with a `#!/usr/bin/env node` shebang. `package.json` `bin: { uniclip: "dist/cli.js" }`. Dev via `tsx src/cli.tsx`.
- **Deps:** `react`, `ink`, `ink-text-input`, `clipboardy` (cross-platform OS-clipboard write), `qrcode` (terminal UTF-8 QR), `@uniclip/client-core`/`room-code` (workspace). Dev: `tsup`, `@types/react`, `ink-testing-library`, `vitest`.
- **Turbo tasks:** standard `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `build` (`tsup`), `lint`. Tests run under plain Node vitest — Ink renders to a string (no jsdom/pty).

## 3. Entry & pairing (`src/cli.tsx`, `src/session.ts`)

`src/cli.tsx` parses `argv`:
- **`uniclip [room-url]`**, flags `--relay <base>` (env `UNICLIP_RELAY`, default `http://localhost:3000`), `--name <device-name>` (optional; passed to `UniclipClient.deviceId/deviceName` for presence).
- **No room-url → create:** `createRoom(relayBase)` does `POST ${relayBase}/api/room {mode:"A"}` → `{roomId}`; `secret = generateModeARoom().secret`; returns `{ roomUrl: "${relayBase}/r/${roomId}#${secret}", relayBase }`. The TUI opens on a **pair screen** showing the URL + ASCII QR until a peer joins.
- **room-url given → join:** `parseRoomUrl(url)` validates it; `relayBase` is derived from the URL origin via `relayBaseFromUrl(url)` (scheme `http→ws`, `https→wss`; the `UniclipClient` appends `/ws/<routingId>`).

`src/session.ts` exports the pure-ish helpers:
- `relayBaseFromUrl(roomUrl: string): string` — origin → `ws`/`wss` base.
- `createRoom(relayBase: string, fetchImpl?): Promise<{ roomUrl: string }>` — POST + secret + URL formation (inject `fetchImpl` for tests).
- `makeClient(opts): UniclipClient` — constructs `new UniclipClient({ roomUrl, relayBase, createConnection: disabledPeer })` (P2P disabled — see §5), optionally `deviceName`.

## 4. TUI layout (`src/app.tsx` + components)

`<App>` owns a `UniclipClient` (injectable for tests) and React state: `status`, `peerCount`, `transport`, `items: {id,text,ts,mine}[]`, `selected: number`, `input: string`, `roster`. It subscribes to client events in a `useEffect` (`clip`→append, `status`/`peer`/`transport`/`presence`→state, `error`→a transient line) and `connect()`s on mount, `disconnect()`s on unmount.

Components (Ink `Box`/`Text` fl/exbox):
- **`<Header>`** — `routingId` · `Mode A` · status (`connecting`/`secure channel`/`relayed`) · `N devices`.
- **`<PairScreen>`** — shown while `peerCount < 2` after a *create*: the share URL + ASCII QR (`asciiQr(roomUrl)`), "Waiting for another device…". Dismisses once a peer joins.
- **`<ClipList>`** — scrollable; each row: `You`/`peer-name` · relative time · text (wrapped/truncated). A selection cursor (`selected` index) highlights one row. Auto-scrolls to newest on receive unless the user has scrolled up.
- **`<Composer>`** — `ink-text-input`; Enter → `client.send(text)` + clear. Enforces the same 32 KB text cap as the web: the web's `MAX_TEXT_BYTES` lives in `apps/web/src/lib/limits.ts` (not a shared package), so the CLI defines its own `MAX_TEXT_BYTES = 32 * 1024` constant (kept aligned with `@uniclip/protocol`'s `MAX_FRAME_BYTES = 64 KB`); oversize input shows an inline warning and blocks send.
- **`<Footer>`** — keybindings: `↑↓ select · c/⏎ copy · esc clear · q quit`.

**Keybindings** via Ink `useInput`: `↑`/`↓` move `selected`; `c` (or Enter when the list is focused) copies the selected item's text to the OS clipboard; `Ctrl-C`/`q` exits (`useApp().exit()`, then `client.disconnect()`). Focus model: the composer has text focus by default; a key (e.g. `Tab` or `Esc`) toggles between composing and list-navigation so single-key shortcuts don't capture typed text.

## 5. Reuse of `client-core` & P2P-disable (`src/disabled-peer.ts`)

`UniclipClient` is used unchanged. **Critical:** its `PeerLink` default `createConnection` is `new RTCPeerConnection`, which is undefined in Node — when a second peer joins, `armPeer()` would throw (currently swallowed, leaving a broken peer + log noise). P4a injects a **never-opening stub** so P2P is cleanly disabled and content rides the relay WS:

```ts
// src/disabled-peer.ts — a fake RTCPeerConnection whose data channel never
// opens, so UniclipClient stays on the relay (P2P/zero-internet is P4b).
export const disabledPeer = () => ({
  onicecandidate: null, ondatachannel: null, onnegotiationneeded: null,
  onconnectionstatechange: null, signalingState: "stable", connectionState: "new",
  localDescription: null,
  createDataChannel: () => ({ readyState: "connecting", send() {}, close() {}, onopen: null, onclose: null, onmessage: null }),
  createOffer: async () => ({ type: "offer", sdp: "" }),
  createAnswer: async () => ({ type: "answer", sdp: "" }),
  setLocalDescription: async () => {}, setRemoteDescription: async () => {},
  addIceCandidate: async () => {}, close() {},
}) as unknown as RTCPeerConnection;
```
(This mirrors the e2e `forceRelay` stub. P4b replaces it with a real Node WebRTC factory.)

## 6. Clipboard & QR helpers
- `src/clipboard.ts`: `copyToClipboard(text: string): Promise<void>` wrapping `clipboardy.write` (wrapped so tests can stub it; failures surface a transient footer message, never crash).
- `src/qr.ts`: `asciiQr(text: string): Promise<string>` via `qrcode.toString(text, { type: "utf8" })`.

## 7. Security model
- **Mode-A zero-knowledge preserved:** secret from `generateModeARoom()` (client-side), embedded only in the URL fragment shown to the user; only `routingId` is sent to the relay; identical AES-GCM envelope/AAD via `client-core`. No new server surface.
- **No persistence / no fingerprint:** history is in-memory for the session; the optional presence `deviceId` is a per-process random id (not stored).
- **Clipboard:** only an explicit user action (select + copy) writes to the OS clipboard; the CLI never auto-reads it in P4a.

## 8. Testing
- **`session.ts`:** `relayBaseFromUrl` maps `https://h/r/x#s` → `wss://h` and `http://h:3000/...` → `ws://h:3000`; `createRoom` (injected `fetchImpl`) POSTs `{mode:"A"}`, forms `/r/<roomId>#<secret>` with a valid Mode-A secret shape.
- **components (`ink-testing-library`):** `<Header>` renders room/mode/status/peers; `<ClipList>` renders rows and marks the selected one; `<Composer>` calls `onSend` on Enter and blocks oversize; `<PairScreen>` renders the URL + a QR block.
- **`<App>` (injected fake `UniclipClient`):** a `clip` event appends a row; `↑↓` moves selection; `c` calls the injected `copyToClipboard` with the selected text; oversize input is blocked; `peer` ≥ 2 hides the pair screen.
- **No pty/integration e2e** (a real TUI against a live relay isn't worth the harness); `client-core` already has full coverage, and the disabled-peer stub keeps everything on the tested relay path.

## 9. Decomposition (for the plan)
1. **Scaffold** `apps/cli` (package.json/bin, tsconfig jsx, tsup, turbo wiring) + a trivial Ink render + `ink-testing-library` smoke test (prove the toolchain).
2. **`session.ts`** — `relayBaseFromUrl`, `createRoom`, `makeClient`, `disabled-peer.ts` (+ unit tests).
3. **`qr.ts` + `clipboard.ts`** helpers (+ tests).
4. **Presentational components** — `Header`, `ClipList`, `Composer`, `PairScreen`, `Footer` (+ ink-testing-library tests).
5. **`<App>`** — client wiring (events→state), `useInput` keybindings, copy-on-select, pair-screen gating (+ injected-client tests).
6. **`cli.tsx` bin** — argv/`--relay`/`--name` parsing, create-vs-join, `render(<App/>)`; a final manual smoke + `pnpm --filter @uniclip/cli build` runs.

Order 1→6; (1)(2)(3) are infra/libs, (4)(5) the UI, (6) the entrypoint.

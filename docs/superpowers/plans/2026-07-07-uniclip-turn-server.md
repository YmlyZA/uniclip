# TURN Server (coturn) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional self-hosted TURN — the relay mints short-lived coturn REST credentials at `GET /api/ice`, the web + CLI clients fetch them before connecting, and a `docker-compose.turn.yml` runs coturn; when `TURN_*` env is unset, behavior is unchanged and `--lan` never fetches.

**Architecture:** A pure `mintIceCredentials` (HMAC-SHA1 REST scheme) on the relay behind a new `/api/ice` route gated by optional `AppDeps.turn`; a fail-safe `fetchIceServers(relayBase)` helper in `client-core` awaited by `apps/web/src/routes/room.svelte` and `apps/cli/src/session.ts`; ops files for coturn. No change to the `transport` state machine or `PeerLink`.

**Tech Stack:** Bun + Hono relay (tests under `bun --bun vitest`), TypeScript client-core (node vitest), Svelte 5 web, Node/Ink CLI, coturn via docker-compose.

## Global Constraints

- **Opt-in / no regression:** `/api/ice` returns the existing `ICE_SERVERS` default (Google STUN) when `deps.turn` is absent; returns self-hosted STUN + ephemeral TURN when present. `TURN_URLS`+`TURN_SECRET` both required to enable (the `TLS_CERT`/`TLS_KEY` pattern in `server.ts:64-67`).
- **`--lan` untouched:** `apps/cli/src/lan-session.ts` keeps `iceServers: []` and never calls `fetchIceServers`.
- **`fetchIceServers` never throws** — on any error (network / non-200 / malformed) it returns the built-in `ICE_SERVERS` default.
- **Credential scheme:** `username = String(unixExpiry)`, `credential = base64(HMAC_SHA1(TURN_SECRET, username))`, `expiry = floor(now/1000) + TURN_TTL` (default `86400`). Creds attach only to `turn:`/`turns:` entries; `stun:` entries carry none. `TURN_SECRET` is never sent to clients and never logged. `TURN_REALM` is coturn-side config only (not needed to mint).
- **werift quirk:** advertise a plain `turn:` entry (CLI/werift only matches `turn:`, not `turns:`); a `turns:` entry may also be advertised for the browser.
- **Relay tests** run under Bun and must cast `res.json()` (e.g. `(await res.json()) as { iceServers: RTCIceServer[] }`).
- **Gates:** `pnpm --filter @uniclip/relay test` + `typecheck`; `pnpm --filter @uniclip/client-core test` + `typecheck`; `pnpm --filter @uniclip/web typecheck` + `build`; `pnpm --filter @uniclip/cli typecheck`.

---

### Task 1: `mintIceCredentials` (relay)

**Files:**
- Create: `apps/relay/src/turn.ts`
- Create: `apps/relay/test/turn.test.ts`

**Interfaces:**
- Produces: `interface TurnConfig { urls: string[]; secret: string; ttlSeconds: number }` and `mintIceCredentials(cfg: TurnConfig, now: number): { iceServers: RTCIceServer[] }`. Consumed by Task 2.

- [ ] **Step 1: Write the failing test**

Create `apps/relay/test/turn.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { mintIceCredentials } from "../src/turn";

const cfg = {
  urls: ["stun:turn.example.com:3478", "turn:turn.example.com:3478", "turns:turn.example.com:5349"],
  secret: "s3cr3t",
  ttlSeconds: 3600,
};

describe("mintIceCredentials", () => {
  it("mints an expiry username and HMAC-SHA1 credential", () => {
    const now = 1_000_000_000_000; // ms
    const { iceServers } = mintIceCredentials(cfg, now);
    const expiry = String(1_000_000_000 + 3600);
    const cred = createHmac("sha1", "s3cr3t").update(expiry).digest("base64");
    const turn = iceServers.find((s) => String(s.urls).startsWith("turn:"))!;
    expect(turn.username).toBe(expiry);
    expect(turn.credential).toBe(cred);
  });

  it("attaches creds to turn:/turns: entries only, not stun:", () => {
    const { iceServers } = mintIceCredentials(cfg, 1_000_000_000_000);
    const stun = iceServers.find((s) => String(s.urls).startsWith("stun:"))!;
    const turns = iceServers.find((s) => String(s.urls).startsWith("turns:"))!;
    expect(stun.username).toBeUndefined();
    expect(stun.credential).toBeUndefined();
    expect(turns.username).toBeDefined();
    expect(turns.credential).toBeDefined();
  });
});
```

- [ ] **Step 2: Run — must fail**

Run: `pnpm --filter @uniclip/relay test turn`
Expected: FAIL — cannot resolve `../src/turn`.

- [ ] **Step 3: Implement `turn.ts`**

Create `apps/relay/src/turn.ts`:

```ts
import { createHmac } from "node:crypto";

// coturn `use-auth-secret` REST scheme: username is the unix expiry, password is
// base64(HMAC-SHA1(static-auth-secret, username)). coturn validates the HMAC with
// no shared per-user state. Creds attach only to turn:/turns: entries.
export interface TurnConfig {
  urls: string[];
  secret: string;
  ttlSeconds: number;
}

export function mintIceCredentials(cfg: TurnConfig, now: number): { iceServers: RTCIceServer[] } {
  const expiry = Math.floor(now / 1000) + cfg.ttlSeconds;
  const username = String(expiry);
  const credential = createHmac("sha1", cfg.secret).update(username).digest("base64");
  const iceServers: RTCIceServer[] = cfg.urls.map((urls) =>
    urls.startsWith("turn:") || urls.startsWith("turns:")
      ? { urls, username, credential }
      : { urls },
  );
  return { iceServers };
}
```

- [ ] **Step 4: Run — must pass**

Run: `pnpm --filter @uniclip/relay test turn`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/turn.ts apps/relay/test/turn.test.ts
git commit -m "feat(relay): mintIceCredentials — coturn REST HMAC ICE credentials"
```

---

### Task 2: `/api/ice` route + env wiring (relay)

**Files:**
- Modify: `apps/relay/src/app.ts` (AppDeps + new route)
- Modify: `apps/relay/src/server.ts` (env → deps)
- Test: `apps/relay/test/ice-route.test.ts`

**Interfaces:**
- Consumes: `mintIceCredentials`, `TurnConfig` (Task 1); `ICE_SERVERS` from `@uniclip/protocol`.
- Produces: `GET /api/ice` → `{ iceServers: RTCIceServer[] }`. Consumed by Tasks 3–4.

- [ ] **Step 1: Write the failing test**

Create `apps/relay/test/ice-route.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";

describe("GET /api/ice", () => {
  it("returns the default STUN when TURN is not configured", async () => {
    const app = buildApp({ roomCount: () => 0 });
    const res = await app.request("/api/ice");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { iceServers: RTCIceServer[] };
    expect(body.iceServers.some((s) => String(s.urls).startsWith("stun:"))).toBe(true);
    expect(body.iceServers.every((s) => s.credential === undefined)).toBe(true);
  });

  it("returns self-hosted STUN+TURN with creds when configured", async () => {
    const app = buildApp({
      roomCount: () => 0,
      turn: { urls: ["stun:t.example:3478", "turn:t.example:3478"], secret: "k", ttlSeconds: 3600 },
    });
    const res = await app.request("/api/ice");
    const body = (await res.json()) as { iceServers: RTCIceServer[] };
    const turn = body.iceServers.find((s) => String(s.urls).startsWith("turn:"))!;
    expect(turn.credential).toBeDefined();
  });
});
```

- [ ] **Step 2: Run — must fail**

Run: `pnpm --filter @uniclip/relay test ice-route`
Expected: FAIL — `turn` not on `AppDeps` / no `/api/ice` route.

- [ ] **Step 3: Add the dep field, import, and route in `app.ts`**

In `apps/relay/src/app.ts`, add imports near the top (after the existing imports):

```ts
import { ICE_SERVERS } from "@uniclip/protocol";
import { mintIceCredentials, type TurnConfig } from "./turn";
```

Add to the `AppDeps` interface (after `updateStatus?`):

```ts
  turn?: TurnConfig;
```

Add the route right after the `/api/version` handler (app.ts:71):

```ts
  app.get("/api/ice", (c) =>
    c.json(deps.turn ? mintIceCredentials(deps.turn, Date.now()) : { iceServers: ICE_SERVERS }),
  );
```

- [ ] **Step 4: Wire env in `server.ts`**

In `apps/relay/src/server.ts`, after the `gitSha` line (server.ts:12), add:

```ts
const turnUrls = (process.env.TURN_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const turnSecret = process.env.TURN_SECRET ?? "";
const turnTtl = Number(process.env.TURN_TTL ?? 86400) || 86400;
const turn = turnUrls.length > 0 && turnSecret ? { urls: turnUrls, secret: turnSecret, ttlSeconds: turnTtl } : undefined;
```

Then add `turn` into the `buildApp({ ... })` deps object (after `gitSha,`), using the optional-spread idiom:

```ts
  ...(turn ? { turn } : {}),
```

- [ ] **Step 5: Run — must pass**

Run: `pnpm --filter @uniclip/relay test ice-route && pnpm --filter @uniclip/relay typecheck`
Expected: PASS (2 tests); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/relay/src/app.ts apps/relay/src/server.ts apps/relay/test/ice-route.test.ts
git commit -m "feat(relay): GET /api/ice serves default STUN or ephemeral coturn TURN creds"
```

---

### Task 3: `fetchIceServers` helper (client-core)

**Files:**
- Create: `packages/client-core/src/ice.ts`
- Create: `packages/client-core/src/ice.test.ts`
- Modify: `packages/client-core/src/index.ts` (export)

**Interfaces:**
- Consumes: `ICE_SERVERS` from `@uniclip/protocol`.
- Produces: `fetchIceServers(relayBase: string, fetchImpl?: typeof fetch): Promise<RTCIceServer[]>`. Consumed by Task 4.

- [ ] **Step 1: Write the failing test**

Create `packages/client-core/src/ice.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fetchIceServers } from "./ice";
import { ICE_SERVERS } from "@uniclip/protocol";

const ok = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe("fetchIceServers", () => {
  it("returns the server's iceServers on success", async () => {
    const servers = [{ urls: "turn:x:3478", username: "1", credential: "c" }];
    const out = await fetchIceServers("https://relay.test", ok({ iceServers: servers }));
    expect(out).toEqual(servers);
  });

  it("falls back to the default on network error", async () => {
    const boom = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect(await fetchIceServers("https://relay.test", boom)).toEqual(ICE_SERVERS);
  });

  it("falls back to the default on non-200 or malformed body", async () => {
    const bad = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await fetchIceServers("https://relay.test", bad)).toEqual(ICE_SERVERS);
    const malformed = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    expect(await fetchIceServers("https://relay.test", malformed)).toEqual(ICE_SERVERS);
  });
});
```

- [ ] **Step 2: Run — must fail**

Run: `pnpm --filter @uniclip/client-core test ice`
Expected: FAIL — cannot resolve `./ice`.

- [ ] **Step 3: Implement `ice.ts`**

Create `packages/client-core/src/ice.ts`:

```ts
import { ICE_SERVERS } from "@uniclip/protocol";

// Fetch ICE servers (self-hosted STUN/TURN when the relay is configured for it)
// before constructing a UniclipClient. Fail-safe: any error yields the built-in
// default so a connection is always attempted. NEVER used by the --lan path.
export async function fetchIceServers(
  relayBase: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RTCIceServer[]> {
  try {
    const base = relayBase.replace(/\/$/, "");
    const res = await fetchImpl(`${base}/api/ice`);
    if (!res.ok) return ICE_SERVERS as RTCIceServer[];
    const body = (await res.json()) as { iceServers?: RTCIceServer[] };
    return Array.isArray(body.iceServers) && body.iceServers.length > 0
      ? body.iceServers
      : (ICE_SERVERS as RTCIceServer[]);
  } catch {
    return ICE_SERVERS as RTCIceServer[];
  }
}
```

- [ ] **Step 4: Export it**

In `packages/client-core/src/index.ts`, add:

```ts
export { fetchIceServers } from "./ice";
```

- [ ] **Step 5: Run — must pass**

Run: `pnpm --filter @uniclip/client-core test ice && pnpm --filter @uniclip/client-core typecheck`
Expected: PASS (3 tests); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/client-core/src/ice.ts packages/client-core/src/ice.test.ts packages/client-core/src/index.ts
git commit -m "feat(client-core): fetchIceServers — fail-safe ICE bootstrap from the relay"
```

---

### Task 4: Wire the fetch into web + CLI

**Files:**
- Modify: `apps/web/src/routes/room.svelte` (~line 78-84)
- Modify: `apps/cli/src/session.ts` (`makeClient`)
- Modify: `apps/cli/src/cli.tsx` (await the now-async `makeClient`)

**Interfaces:**
- Consumes: `fetchIceServers` (Task 3). `httpBase` (web, room.svelte:33) / `relayBaseFromUrl` (cli, session.ts:7).

- [ ] **Step 1: Web — fetch before constructing the client**

In `apps/web/src/routes/room.svelte`, add the import with the other `@uniclip/client-core` imports (near the top `<script>`):

```ts
  import { fetchIceServers } from "@uniclip/client-core";
```

Replace the client construction (room.svelte:78-84, the `forceRelay` line through the `UniclipClient` options head) so ICE servers are fetched first and `forceRelay` still forces `[]`:

```ts
    const forceRelay = new URLSearchParams(location.search).has("forceRelay");
    const iceServers = forceRelay ? [] : await fetchIceServers(httpBase);

    const c = new UniclipClient({
      roomUrl,
      relayBase,
      deviceId: deviceId(),
      deviceName,
      iceServers,
      ...(forceRelay
        ? {
            createConnection: () =>
```

(Only two changes: add `const iceServers = …`, add `iceServers,` to the options, and drop `iceServers: []` from the `forceRelay` spread object — the leading `createConnection: () =>` line is unchanged, so keep the rest of that stub block exactly as-is. `onMount` is already `async`, so `await` is fine.)

- [ ] **Step 2: CLI — make `makeClient` async and fetch**

In `apps/cli/src/session.ts`, add `fetchIceServers` to the import from `@uniclip/client-core`:

```ts
import { UniclipClient, fetchIceServers } from "@uniclip/client-core";
```

Replace `makeClient` (session.ts:37-44) with an async version that fetches from the ws→http relay base (the werift adapter forwards `username`/`credential` already):

```ts
export async function makeClient(opts: { roomUrl: string; deviceName?: string; relayOnly?: boolean }): Promise<UniclipClient> {
  const relayBase = relayBaseFromUrl(opts.roomUrl);
  const httpBase = relayBase.replace(/^ws/, "http");
  const iceServers = await fetchIceServers(httpBase);
  return new UniclipClient({
    roomUrl: opts.roomUrl,
    relayBase,
    iceServers,
    createConnection: peerFactory(opts.relayOnly ?? false),
    ...(opts.deviceName ? { deviceName: opts.deviceName } : {}),
  });
}
```

- [ ] **Step 3: CLI — await the caller**

In `apps/cli/src/cli.tsx`, find the `makeClient(...)` call (around line 85) and add `await` (its enclosing function is already async in the non-LAN branch; if it is not, wrap the call site so it is awaited before rendering). Change:

```tsx
    const client = makeClient({ roomUrl, relayOnly, ...(deviceName ? { deviceName } : {}) });
```

to:

```tsx
    const client = await makeClient({ roomUrl, relayOnly, ...(deviceName ? { deviceName } : {}) });
```

(If the surrounding function is not `async`, make it `async` — `makeClient` now returns a Promise. `lan-session.ts` is NOT touched: the `--lan` branch keeps `startLanHost`/`joinLan` with `iceServers: []` and never calls `fetchIceServers`.)

- [ ] **Step 4: Verify — typecheck + build**

Run:
```bash
pnpm --filter @uniclip/web typecheck && pnpm --filter @uniclip/web build
pnpm --filter @uniclip/cli typecheck
```
Expected: svelte-check clean; web build succeeds; CLI typecheck clean. (If the CLI has unit tests that call `makeClient`, update them to `await`; run `pnpm --filter @uniclip/cli test` and report.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/room.svelte apps/cli/src/session.ts apps/cli/src/cli.tsx
git commit -m "feat(web,cli): fetch ICE servers from the relay before connecting (LAN untouched)"
```

---

### Task 5: coturn ops files + docs

**Files:**
- Create: `docker-compose.turn.yml`
- Create: `deploy/coturn/turnserver.conf`
- Modify: `deploy/README.md` (TURN section)

**Interfaces:** none (ops only). Consumes the env contract from Task 2 (`TURN_URLS`, `TURN_SECRET`, `TURN_TTL`) and coturn's `static-auth-secret`/`realm`.

- [ ] **Step 1: Create `deploy/coturn/turnserver.conf`**

```conf
# coturn config for uniclip self-hosted TURN. TURN relays only encrypted DTLS —
# it never sees plaintext or keys. Auth is the REST/use-auth-secret scheme; the
# relay mints time-limited credentials (see apps/relay/src/turn.ts).
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=REPLACE_WITH_TURN_SECRET
realm=REPLACE_WITH_DOMAIN
# Relay port range for media (open these UDP ports on the host/firewall):
min-port=49160
max-port=49200
no-cli
no-multicast-peers
# For turns: (TLS) reuse your domain cert, or omit tls-listening-port to run
# plain turn: only.
# cert=/etc/coturn/fullchain.pem
# pkey=/etc/coturn/privkey.pem
```

- [ ] **Step 2: Create `docker-compose.turn.yml`**

```yaml
# Optional self-hosted TURN for uniclip. Run alongside the relay:
#   docker compose -f docker-compose.turn.yml up -d
# Then set on the relay:  TURN_URLS, TURN_SECRET (== static-auth-secret below).
services:
  coturn:
    image: coturn/coturn:4.6
    restart: unless-stopped
    network_mode: host           # TURN needs the media UDP port range on the host
    volumes:
      - ./deploy/coturn/turnserver.conf:/etc/coturn/turnserver.conf:ro
    command: ["-c", "/etc/coturn/turnserver.conf"]
```

- [ ] **Step 3: Document in `deploy/README.md`**

Append a "Self-hosted TURN (optional)" section covering: generate a secret (`openssl rand -hex 32`), put it in both `turnserver.conf` (`static-auth-secret`) and the relay env `TURN_SECRET`; set `TURN_URLS=turn:<domain>:3478,turns:<domain>:5349,stun:<domain>:3478`; open UDP `3478` + `49160-49200` (and TCP `5349` for `turns:`) on the firewall; verify with Trickle-ICE (webrtc.github.io/samples) or `turnutils_uclient -v -t -u <username> -w <credential> <domain>` where a username/credential pair comes from `GET /api/ice`. Note `TURN_TTL` default `86400`, and that unset `TURN_*` keeps the Google-STUN default.

- [ ] **Step 4: Verify shape**

Run: `docker compose -f docker-compose.turn.yml config >/dev/null && echo ok`
Expected: `ok` (compose file parses). (Do not start coturn in CI.)

- [ ] **Step 5: Commit**

```bash
git add docker-compose.turn.yml deploy/coturn/turnserver.conf deploy/README.md
git commit -m "docs(deploy): coturn docker-compose + turnserver.conf + TURN setup guide"
```

---

## Final verification (after all tasks)

- [ ] `pnpm --filter @uniclip/relay test` + `pnpm --filter @uniclip/client-core test` green; repo `pnpm typecheck` clean; `pnpm --filter @uniclip/web build` succeeds.
- [ ] Whole-branch review (opus): `/api/ice` disabled path returns exactly today's default (no regression); creds attach to `turn:`/`turns:` only; `TURN_SECRET` never logged/returned; `fetchIceServers` cannot throw; **`--lan` path unchanged** (`lan-session.ts` still `iceServers: []`, `werift-hostonly.test.ts` still green); no change to the `transport` state machine.
- [ ] Manual (user, when deploying): stand up coturn, set `TURN_URLS`/`TURN_SECRET`, confirm `GET /api/ice` returns TURN creds and Trickle-ICE shows a `relay` candidate.

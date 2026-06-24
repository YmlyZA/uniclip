# Task 3 Report — p2p presence-drop test hardening

## Changes made

### Fix 1: Hardened `drops a presence frame arriving over the p2p pipe` test

Before (vacuous — optional chaining meant the call was a no-op if `ch` or `ch.onmessage` was null):
```ts
const ch = (b as any).peer?.channel;
ch?.onmessage?.({ data: JSON.stringify(presenceFrame) });
```

After (non-vacuous — asserts the channel and handler exist, then delivers via non-optional call):
```ts
const ch = (b as any).peer?.channel;
expect(ch).toBeTruthy();
expect(ch.onmessage).toBeTruthy();
ch.onmessage!({ data: JSON.stringify(presenceFrame) });
```

File: `packages/client-core/src/client.test.ts` (lines 707-710)

### Fix 2: Removed dead `fakeChannelOf` helper

Deleted the unused function (was lines 650-658 in the original):
```ts
// Helper: grab the open fake data channel from a client connected with fakePcFactory.
// Mirrors the pattern used in the via-guard test: (client as any).peer?.channel.
function fakeChannelOf(ws: MockWebSocket): { onmessage: ((ev: { data: string }) => void) | null } {
  // ...
  return { onmessage: null }; // fallback; callers override with the real channel below
}
```

### Fix 3: Removed unused `describe` import in `presence.test.ts`

Before: `import { afterEach, describe, expect, it, vi } from "vitest";`
After: `import { afterEach, expect, it, vi } from "vitest";`

## RED evidence (guard bypassed)

Temporarily changed `packages/client-core/src/client.ts` presence case from:
```ts
case "presence":
  if (via !== "ws") return;
  await this.presence.handlePresence(frame);
  return;
```
to:
```ts
case "presence":
  await this.presence.handlePresence(frame);
  return;
```

Test output (FAIL):
```
× src/client.test.ts > UniclipClient presence > drops a presence frame arriving over the p2p pipe
  → expected true to be false // Object.is equality

AssertionError: expected true to be false // Object.is equality

- Expected
+ Received

- false
+ true

 ❯ src/client.test.ts:704:86
```

Guard was then restored.

## GREEN output (guard restored)

```
 RUN  v2.1.9 /Volumes/T9/Projects/uniclip/.claude/worktrees/agent-abc5ff41ac449245c/packages/client-core

 ✓ src/backoff.test.ts (3 tests) 3ms
 ✓ src/peer-link.test.ts (6 tests) 6ms
 ✓ src/room-key.test.ts (2 tests) 106ms
 ✓ src/presence.test.ts (6 tests) 229ms
 ✓ src/file-transfer.test.ts (14 tests) 361ms
 ✓ src/client.test.ts (28 tests) 2155ms
   ✓ UniclipClient transport seam > re-announces its identity on reconnect (re-arm) 1119ms

 Test Files  6 passed (6)
      Tests  59 passed (59)
```

## Typecheck

```
> @uniclip/client-core@0.0.0 typecheck
> tsc -p tsconfig.json --noEmit
(clean — exit 0)
```

## Verify commands used

```bash
pnpm --filter @uniclip/client-core test   # 59 tests, all pass
pnpm --filter @uniclip/client-core typecheck  # clean
```

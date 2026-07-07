# Mobile Header Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On phones (`< sm`, 640px) collapse the `apps/web` header's long text labels to icons/dots — status label→dot-only, "Sync" word dropped, Direct/Relayed text→bolt/cloud SVG, "Ephemeral · not saved"→hourglass icon — while desktop (`≥ sm`) stays exactly as today.

**Architecture:** A pure `statusAriaLabel` helper (so the screen-reader string has one definition), a small `transport-badge.svelte` (bolt/cloud SVG), a one-line change to `status-pill.svelte` (hide label `< sm`), and the header integration. Presentation only — no sync/transport/status logic changes.

**Tech Stack:** Svelte 5 (runes) + Tailwind 4. Web tests are pure-function node vitest tests (no component/jsdom tests). Icons are inline SVG matching the existing idiom.

## Global Constraints

- **Breakpoint:** Tailwind `sm` (640px). Mobile = `< sm` (labels collapse); desktop = `≥ sm` (unchanged). Pattern: label span gets `hidden sm:inline` (or `hidden sm:inline-flex`), the icon/dot is always rendered.
- **Desktop must not regress** — the `sm:` variants reproduce today's exact markup/classes.
- **Icons are SVG in the existing style:** `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`, `stroke-width` ~1.7, `aria-hidden="true"` on the `<svg>`. **No emoji.**
- **Accessibility:** every icon-only control/indicator keeps an `aria-label`; the status indicator's label comes from `statusAriaLabel(status, transport)`. `title` tooltips stay (desktop nicety).
- **Sync compact toggle** is `lg:hidden` (already) — drop only the trailing "Sync" text; keep the switch + `aria-label`. The `sync-toggle.svelte` desktop rail (`≥ lg`) is untouched.
- **Transport badge** shows only when `status === "connected"`; bolt for `p2p`, cloud for `relay`.
- **Web gates:** `pnpm --filter @uniclip/web test`, `pnpm --filter @uniclip/web typecheck` (svelte-check), `pnpm --filter @uniclip/web build`. Header-only; no other page/component touched.

---

### Task 1: `statusAriaLabel` helper

**Files:**
- Create: `apps/web/src/lib/a11y.ts`
- Create: `apps/web/src/lib/a11y.test.ts`

**Interfaces:**
- Produces: `statusAriaLabel(status: "connecting" | "connected" | "reconnecting" | "disconnected", transport: "p2p" | "relay"): string`. Consumed by Tasks 3 & 4.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/a11y.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { statusAriaLabel } from "./a11y";

describe("statusAriaLabel", () => {
  it("appends the transport only when connected", () => {
    expect(statusAriaLabel("connected", "p2p")).toBe("Connected · Direct (P2P)");
    expect(statusAriaLabel("connected", "relay")).toBe("Connected · Relayed");
  });
  it("names the non-connected states without transport", () => {
    expect(statusAriaLabel("connecting", "relay")).toBe("Connecting");
    expect(statusAriaLabel("reconnecting", "p2p")).toBe("Reconnecting");
    expect(statusAriaLabel("disconnected", "relay")).toBe("Offline");
  });
});
```

- [ ] **Step 2: Run — must fail**

Run: `pnpm --filter @uniclip/web test a11y`
Expected: FAIL — cannot resolve `./a11y`.

- [ ] **Step 3: Implement `a11y.ts`**

Create `apps/web/src/lib/a11y.ts`:

```ts
// Screen-reader label for the header status indicator. On mobile the visible UI
// is only a colored dot (+ a transport glyph), so this carries the full meaning.
type Status = "connecting" | "connected" | "reconnecting" | "disconnected";
type Transport = "p2p" | "relay";

const STATUS_WORD: Record<Status, string> = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Offline",
};

export function statusAriaLabel(status: Status, transport: Transport): string {
  if (status !== "connected") return STATUS_WORD[status];
  return `Connected · ${transport === "p2p" ? "Direct (P2P)" : "Relayed"}`;
}
```

- [ ] **Step 4: Run — must pass**

Run: `pnpm --filter @uniclip/web test a11y`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/a11y.ts apps/web/src/lib/a11y.test.ts
git commit -m "feat(web): statusAriaLabel helper for the header status indicator"
```

---

### Task 2: `transport-badge.svelte`

**Files:**
- Create: `apps/web/src/components/transport-badge.svelte`

**Interfaces:**
- Consumes: nothing (self-contained).
- Produces: a component with prop `transport: "p2p" | "relay"`. Renders a bolt (p2p) or cloud (relay) SVG. Used by Task 4 (in the header, behind `sm:hidden`, only when connected).

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/transport-badge.svelte`:

```svelte
<script lang="ts">
  let { transport }: { transport: "p2p" | "relay" } = $props();
</script>

<!-- Direct (P2P) = bolt, accent-tinted (the "upgraded" path); Relayed = cloud, muted. -->
<span
  class="grid h-6 w-6 place-items-center {transport === 'p2p' ? 'text-accent' : 'text-faint'}"
  title={transport === "p2p" ? "Direct peer-to-peer (LAN when local)" : "Relayed through the server"}
  aria-label={transport === "p2p" ? "Direct (peer-to-peer)" : "Relayed (through the server)"}
  role="img"
>
  {#if transport === "p2p"}
    <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true">
      <path d="M13 3 5 13h5l-1 8 8-11h-5z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" />
    </svg>
  {:else}
    <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true">
      <path d="M7 18a4 4 0 0 1 .5-8 5 5 0 0 1 9.6 1.4A3.3 3.3 0 0 1 16.5 18Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" />
    </svg>
  {/if}
</span>
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm --filter @uniclip/web typecheck`
Expected: svelte-check clean (0 errors). (No unit test — it's a presentational SVG shell; the `transport` prop logic is trivial and covered by inspection.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/transport-badge.svelte
git commit -m "feat(web): transport-badge — bolt (Direct) / cloud (Relayed) SVG"
```

---

### Task 3: `status-pill.svelte` — dot-only on mobile

**Files:**
- Modify: `apps/web/src/components/status-pill.svelte`

**Interfaces:**
- Consumes: `statusAriaLabel` (Task 1). The component already takes `status`. It gains an optional `transport` prop so its `aria-label` can name Direct/Relayed.
- Produces: on `< sm`, only the dot; on `≥ sm`, dot + label (as today). `aria-label` always present.

- [ ] **Step 1: Update the component**

The current file renders `<span>{dot}</span><span>{m.label}</span>`. Change it to (a) accept `transport`, (b) set an `aria-label` from `statusAriaLabel`, (c) hide the label text `< sm`. Replace the whole file with:

```svelte
<script lang="ts">
  import { statusAriaLabel } from "../lib/a11y";

  let {
    status,
    transport = "relay",
  }: {
    status: "connecting" | "connected" | "reconnecting" | "disconnected";
    transport?: "p2p" | "relay";
  } = $props();

  const meta = {
    connecting: { label: "Connecting", color: "var(--warn)", live: false },
    connected: { label: "Secure channel", color: "var(--ok)", live: true },
    reconnecting: { label: "Reconnecting", color: "var(--warn)", live: false },
    disconnected: { label: "Offline", color: "var(--danger)", live: false },
  } as const;

  let m = $derived(meta[status]);
  let aria = $derived(statusAriaLabel(status, transport));
</script>

<span
  class="inline-flex items-center gap-2 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs font-medium"
  role="status"
  aria-label={aria}
  title={aria}
>
  <span class="relative flex h-2.5 w-2.5 items-center justify-center">
    {#if m.live}
      <span
        class="absolute inset-0 rounded-full"
        style="background:{m.color};animation:ping 1.7s cubic-bezier(0,0,.2,1) infinite"
      ></span>
    {/if}
    <span class="relative h-2.5 w-2.5 rounded-full" style="background:{m.color}"></span>
  </span>
  <span class="hidden sm:inline" style="color:{m.color}">{m.label}</span>
</span>
```

(Only two functional changes from today: the label span is now `hidden sm:inline`, and the pill has `role="status"` + `aria-label`/`title` from `statusAriaLabel`. The dot, colors, and ping are unchanged. On mobile the pill shrinks to the dot inside its existing rounded border — a compact indicator.)

- [ ] **Step 2: Verify compiles + existing web tests pass**

Run: `pnpm --filter @uniclip/web typecheck && pnpm --filter @uniclip/web test`
Expected: svelte-check clean; full web suite passes (nothing asserts on the status label text; if a test does, it will surface here — none is expected).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/status-pill.svelte
git commit -m "feat(web): status pill is dot-only below sm; aria-label carries state"
```

---

### Task 4: `header.svelte` integration

**Files:**
- Modify: `apps/web/src/components/header.svelte`

**Interfaces:**
- Consumes: `TransportBadge` (Task 2), the updated `StatusPill` (Task 3, now accepts `transport`).
- Produces: mobile header with the "Sync" word dropped, ephemeral text hidden `< sm`, and the transport shown as the bolt/cloud badge `< sm` (when connected) while the Direct/Relayed text pill shows `≥ sm`.

- [ ] **Step 1: Import the transport badge**

In `apps/web/src/components/header.svelte`, add to the `<script>` imports (after the `RosterPopover` import):

```ts
  import TransportBadge from "./transport-badge.svelte";
```

- [ ] **Step 2: Pass `transport` to the status pill**

Change the existing `<StatusPill {status} />` (around line 94) to:

```svelte
      <StatusPill {status} {transport} />
```

- [ ] **Step 3: Drop the "Sync" word from the compact toggle**

In the compact sync `<button>` (the `lg:hidden` one), remove the trailing `Sync` text node so only the switch remains. Change the end of that button from:

```svelte
        <span class="relative h-4 w-7 shrink-0 rounded-full border transition-colors {syncing ? 'border-accent bg-accent' : 'border-border-strong bg-surface-2'}">
          <span class="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full transition-all {syncing ? 'left-[0.9rem] bg-accent-fg' : 'left-0.5 bg-text/70'}"></span>
        </span>
        Sync
      </button>
```

to (drop the `Sync` line):

```svelte
        <span class="relative h-4 w-7 shrink-0 rounded-full border transition-colors {syncing ? 'border-accent bg-accent' : 'border-border-strong bg-surface-2'}">
          <span class="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full transition-all {syncing ? 'left-[0.9rem] bg-accent-fg' : 'left-0.5 bg-text/70'}"></span>
        </span>
      </button>
```

(The button already has `aria-label="Toggle clipboard sync"` and a `title`, so meaning is preserved. Note its padding class is `px-2 py-1`; with no text it becomes a compact switch — acceptable, no class change needed.)

- [ ] **Step 4: Transport — badge on mobile, text pill on desktop**

Replace the existing transport `<span data-testid="transport">…</span>` block (around lines 118–124) with a mobile badge (only when connected) plus the desktop text pill:

```svelte
      {#if status === "connected"}
        <span class="sm:hidden"><TransportBadge {transport} /></span>
      {/if}
      <span
        data-testid="transport"
        class="hidden rounded-field px-2 py-0.5 text-[11px] sm:inline-flex {transport === 'p2p' ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-faint'}"
        title={transport === "p2p" ? "Direct peer-to-peer (LAN when local)" : "Relayed through the server"}
      >
        {transport === "p2p" ? "Direct" : "Relayed"}
      </span>
```

(The text pill keeps `data-testid="transport"` for any existing/E2E selector, now `hidden sm:inline-flex`. The mobile badge is `sm:hidden` and only rendered when connected.)

- [ ] **Step 5: Ephemeral — hide the text on mobile**

In the ephemeral badge (around lines 65–75), wrap the trailing `Ephemeral · not saved` text in a `hidden sm:inline` span so only the hourglass SVG shows on mobile. Change:

```svelte
        <svg viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5" aria-hidden="true">
          <path d="M7 4h10M7 20h10M8 4c0 5 8 5 8 0M8 20c0-5 8-5 8 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        Ephemeral · not saved
      </span>
```

to:

```svelte
        <svg viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5" aria-hidden="true">
          <path d="M7 4h10M7 20h10M8 4c0 5 8 5 8 0M8 20c0-5 8-5 8 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="hidden sm:inline">Ephemeral · not saved</span>
      </span>
```

(The badge's outer `<span>` already has `title="Nothing is saved on any device; items vanish after 60s"`, so the icon-only mobile form stays explained.)

- [ ] **Step 6: Verify — compiles, tests, build**

Run:
```bash
pnpm --filter @uniclip/web typecheck
pnpm --filter @uniclip/web test
pnpm --filter @uniclip/web build
```
Expected: svelte-check clean; full web suite passes; build succeeds. (If any web/E2E test selects the transport by text, note it — the `data-testid="transport"` element still exists, now desktop-only; a mobile-viewport E2E might need the badge's `aria-label`. Report if so.)

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/header.svelte
git commit -m "feat(web): mobile header — icons for status/sync/transport/ephemeral; desktop unchanged"
```

---

## Final verification (after all tasks)

- [ ] `pnpm --filter @uniclip/web test` (a11y + full web suite) and `pnpm typecheck` (all packages) clean.
- [ ] `pnpm --filter @uniclip/web build` succeeds.
- [ ] Whole-branch review (opus): confirm desktop markup is unchanged (`sm:` variants reproduce today's classes), every icon-only element has an `aria-label`, `statusAriaLabel` is the single source of the status string, and no non-header component was touched.
- [ ] E2E selector safety: `e2e/tests/offline-queue.spec.ts` asserts `getByText(/secure channel/i)`. Playwright's default viewport (1280×720) is ≥ `sm`, so the label stays visible and the test is unaffected — but confirm no E2E runs a `< sm` mobile viewport that would now miss the (hidden) label. (`pnpm test` excludes e2e; this is a note for whoever next runs `pnpm test:e2e`.)
- [ ] Real-device acceptance (user): on a phone the header fits one row — status is a dot, sync is a bare switch, transport is the bolt/cloud glyph (when connected), ephemeral is the hourglass; on desktop nothing changed. (This visual gate is the user's, not automated.)

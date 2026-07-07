# Uniclip — Mobile header polish (icons on phones) — Design Spec

**Date:** 2026-07-07
**Status:** Approved (pending spec review)
**Scope:** A responsive polish pass on the `apps/web` **header**: below the `sm` breakpoint (640px, i.e. phones), the long text labels that still ride along collapse to icons/dots; at `sm`+ the header is unchanged. Reclaims the cramped mobile header row (it currently wraps to two lines). Feature 1 (versioning) deliberately kept the version footer out of the header for this. Other pages/components (composer, item-rows, landing, modals) are out of scope this cycle.

## 1. Goals and non-goals

### Goals
1. On phones, the header fits **one clean row** — long labels ("Secure channel", "Sync", "Direct"/"Relayed", "Ephemeral · not saved") become icons/dots.
2. **Desktop (≥ sm) is unchanged** — the full text labels stay exactly as today; no visual regression.
3. **Accessibility is preserved** — every icon-ified element keeps an `aria-label`; meaning rides on color + distinct shape (touch has no hover tooltip); `title` tooltips remain a desktop nicety.
4. All new glyphs are **SVG in the existing thin-stroke, `currentColor` style** — no emoji.

### Non-goals / deferred
- No change below the header (composer, item-rows, landing, modals) — header-first per the user.
- No new colors/theme tokens, no layout framework change; Tailwind 4 utilities + the existing SVG idiom only.
- The room-code chip and mode-chip already hide on mobile (`hidden sm:inline-flex`, mode shown in the "More" menu) — left as-is.
- No behavior change to sync/transport/status logic — this is presentation only.

## 2. Per-element behavior

Breakpoint: Tailwind `sm` (640px). "Mobile" = `< sm`; "desktop" = `≥ sm`. Pattern: the label span gets `hidden sm:inline` (or the element toggles between a compact and full variant), the icon/dot is always present.

| Element (component) | Mobile (`< sm`) | Desktop (`≥ sm`, unchanged) |
|---|---|---|
| **Status pill** (`status-pill.svelte`) | dot only — its color + live "ping" pulse encodes state (green = connected, amber = connecting/reconnecting, red = offline); the text label is hidden | dot + label ("Secure channel" / "Connecting" / "Reconnecting" / "Offline") |
| **Sync toggle** (compact block in `header.svelte`, already `lg:hidden`) | the switch only — the word "Sync" is dropped entirely (the switch + accent = on conveys state); this compact toggle exists only `< lg`, and the full `sync-toggle.svelte` rail takes over at `≥ lg` | the desktop rail card (`≥ lg`) is untouched |
| **Transport** (`header.svelte`) | a small **SVG glyph** beside the status dot — **bolt = Direct, cloud = Relayed**; shown only when connected; muted normally, accent-tinted for Direct (the "upgraded" state) | the existing "Direct" / "Relayed" text pill |
| **Ephemeral badge** (`header.svelte`) | the existing hourglass **icon only** (text "Ephemeral · not saved" hidden) | icon + "Ephemeral · not saved" |
| Roster, theme, share, more | already icons — unchanged both sizes | unchanged |

## 3. Components & structure

- **`status-pill.svelte`** — wrap the label span in `hidden sm:inline` so only the dot shows on mobile. The dot, colors, and ping animation are unchanged. Add/keep an `aria-label` on the pill reflecting the status (screen readers still get the word even when the visible label is hidden).
- **New `transport-badge.svelte`** — a small component taking `transport: "p2p" | "relay"`; renders the bolt (p2p) or cloud (relay) SVG in the thin-stroke style, `aria-label` "Direct (peer-to-peer)" / "Relayed (through the server)", `title` for desktop hover. Used in the header on mobile in place of the text pill. Keeps the SVGs isolated and testable-by-inspection.
- **`header.svelte`** — the one integrator:
  - Sync mobile button: remove the trailing "Sync" text node (keep the switch + `aria-label="Toggle clipboard sync"`).
  - Status + transport: render `<StatusPill>` (dot-only on mobile via its own class) and, on mobile only (`sm:hidden`), the `<TransportBadge>` when `status === "connected"`; keep the existing `Direct/Relayed` text pill as `hidden sm:inline-flex` (desktop).
  - Ephemeral badge: wrap its "Ephemeral · not saved" text in `hidden sm:inline`, leaving the hourglass SVG.
- **New `lib/a11y.ts`** — `statusAriaLabel(status, transport)` composes the screen-reader string, e.g. `"Connected · Direct (P2P)"`, `"Connected · Relayed"`, `"Reconnecting"`, `"Offline"`. Pure function, unit-tested in node. Consumed by the status pill / header so the composed label has one definition.

## 4. Accessibility

- **`aria-label` on every icon-only control/indicator.** The status indicator uses `statusAriaLabel(status, transport)` so a screen reader announces the full meaning that the mobile UI shows only as color+shape.
- **Color + shape carry meaning on touch** (no hover): the status dot's three-color scheme and the distinct bolt-vs-cloud shapes are the legibility mechanism (chosen in design for exactly this reason). `title` tooltips are retained but treated as a desktop-only enhancement, not the sole information channel.
- **Contrast/existing tokens** — reuse the current `--ok/--warn/--danger` dot colors and `text-muted`/`text-accent` for glyphs; no new low-contrast combinations. Respect the existing `bg-black/NN` → plain-rgba caveat is not triggered here (no scrims added).
- **No desktop regression** — the `sm:` variants reproduce today's exact markup.

## 5. Testing

- **`lib/a11y.test.ts`** (node, vitest, pure): `statusAriaLabel` for each status, and the connected×(p2p|relay) combinations → the exact composed strings.
- **`svelte-check`** clean and **`vite build`** succeeds (catches runes/markup errors; the responsive classes and SVGs compile).
- The responsive show/hide and visual result are **CSS/markup** and not unit-testable here (consistent with how `footer.svelte`/`debug-overlay.svelte` shipped) — the final gate is the user's real-device check on a phone (header fits one row; labels/icons legible; desktop unchanged) plus a desktop spot-check.
- Existing header/web tests must still pass (this touches markup the current suite doesn't assert against by text, but confirm none break).

## 6. Decomposition (for the plan)

1. **`lib/a11y.ts` + test** — `statusAriaLabel(status, transport)` composed strings (TDD).
2. **`transport-badge.svelte`** — bolt/cloud SVG component (aria/title), used behind an `sm:hidden` in the header.
3. **`status-pill.svelte`** — hide the label `< sm` (dot-only), wire the composed `aria-label`.
4. **`header.svelte`** — drop the mobile "Sync" word; ephemeral text → `hidden sm:inline`; render `TransportBadge` on mobile + keep the Direct/Relayed text pill on desktop; verify one-row layout via `svelte-check`/build.

Order 1→4: the pure helper + the badge component first, then the two header-area edits that consume them. Each step ends `svelte-check`-clean and buildable; the phone eyeball is the final acceptance.

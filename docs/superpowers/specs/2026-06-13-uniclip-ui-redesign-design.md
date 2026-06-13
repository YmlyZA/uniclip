# Uniclip UI Redesign — Design Spec

**Date:** 2026-06-13
**Status:** Approved (pending spec review)
**Scope:** A presentation-layer redesign of the existing v0.1 web app (Svelte 5 + Tailwind 4) covering three goals at once — visual refresh, usability / information hierarchy, and mobile experience — plus four discrete usability affordances. No protocol, crypto, relay, or client-core behavior changes. Implementation visuals are produced via the `frontend-design` skill.

## 1. Goals and non-goals

### Goals
1. **Visual refresh** — replace the black-and-white functional prototype with a coherent "secure / crafted" visual language (see §3), in both light and dark themes.
2. **Usability & information hierarchy** — surface what matters (connection status, security mode, the live shared list, the core sync action) and clarify the manual-vs-auto sync mental model.
3. **Mobile experience** — thumb-zone primary actions, large touch targets, responsive layout.

### Non-goals (deferred)
- Images/files, accounts, multi-peer (>2) polished UX, and any other v0.2 item.
- Any change to `client-core`, `crypto`, `protocol`, `room-code`, the relay, persistence, or the wire/AAD contracts. This is **presentation + small UX affordances only**.
- Final palette hex values, exact motion curves, and iconography/illustration — these are produced and proposed by `frontend-design`. This spec fixes structure, hierarchy, states, and behavior.

## 2. Locked decisions (from brainstorming)
- **Visual tone:** "security-feel," dark-led. Encryption/connection state reinforced with color + micro-motion; reads as a professional encryption tool.
- **Interaction model:** **auto-sync is the hero.** A prominent, self-explaining "Sync this device" toggle is the primary action; once on, copied text flows automatically. The room reads as a live shared list. Manual "Send now" is secondary.
- **Usability affordances (all in scope):** tap-whole-item-to-copy + copied feedback; sent-by-me vs received distinction; first-run/empty-state guidance; per-item delete + clear history.
- **Theme strategy:** manual toggle (light / dark / system), persisted; **both themes are designed.** Default = system.
- **Room layout:** **responsive hybrid** — mobile = bottom thumb-zone action bar; desktop = left control panel + right list.

## 3. Design system foundation

- **Theming:** light + dark token sets via Tailwind 4 `@theme`. A small `lib/theme.ts` store holds the choice (`light | dark | system`), persists it to `localStorage`, applies it as a class/`data-theme` on `<html>`, and reacts to `prefers-color-scheme` when set to `system`. Avoid FOUC (apply the stored theme before first paint).
- **Palette:** a neutral base ramp (slate/zinc-like) + **one accent** (electric cyan or violet — `frontend-design` proposes 2–3 candidates). Semantic colors: connected = green, Mode-B warning = amber, destructive (End/clear) = red. Dark is the primary-tuned theme; light is a faithful counterpart.
- **Typography:** system sans for UI chrome; **monospace for clipboard content** (payloads are text/code). A defined type scale (display / title / body / caption).
- **Surface & shape:** subtle borders + soft shadows (light) and layered surfaces (dark) — deliberately not flat; one consistent radius scale. Conveys "crafted / secure."
- **Motion:** micro-interactions reinforce state — connection-status pulse, sync-on glow, copied check, new-item arrival. Fast (≈150–250ms); must respect `prefers-reduced-motion`.
- **Security as visual language:** a recurring lock/shield motif; Mode-A (zero-knowledge) gets the accent/positive treatment, Mode-B gets a persistent amber chip; connection state is always visible and color-coded.

## 4. Landing screen

- **Brand/hero:** a brand mark + one-line value prop (e.g. "End-to-end encrypted clipboard — the relay never sees your text") with a lock/trust cue.
- **Primary — Start a room:** the A/B security choice is made clear and visual:
  - **Mode A "Zero-knowledge"** is the recommended default, framed positively in plain words ("the secret stays in your link and is never sent to the server").
  - **Mode B "Typed code"** is the explicit less-secure alternative with an inline amber warning ("the server can decrypt").
  - **Backfill** toggle (Mode A only) with a one-line plain explanation ("share recent items with devices that join later").
- **Secondary — Join with code:** a clean 6-character input (uppercase, spaced).
- **Mobile:** single column, generous targets, primary CTA within thumb reach.

## 5. Room screen (responsive hybrid)

### Header (both breakpoints)
- Brand, room id (monospace), a prominent **connection status pill** (color-coded: connecting / connected / reconnecting / disconnected), **peer count**, and a **security mode chip** (A = accent lock; B = amber "less secure"). This resolves the current "status buried in a gray line" problem.
- Houses the **theme toggle**. On mobile, Share/End/clear move into a header overflow menu.

### Control region
- **Mobile:** a fixed **bottom action bar** in the thumb zone containing the **"Sync this device" hero toggle** (large; label + subtext "copies flow automatically") and a secondary **"Send now"**.
- **Desktop:** a **left control panel** with the sync toggle (hero), Send now, Share, End, and room/security info.

### List
- The live shared list fills the main area (right column on desktop, center on mobile), newest first, scrollable.

### Sync behavior + mobile reality
- When **on**, a clear "live" indicator (pulse). On mobile, where background clipboard auto-read can't run (page must be focused / permission), surface a gentle hint explaining the limitation rather than silently doing nothing.

## 6. Items / list

- **Row content:** the text (monospace, sensible clamp + expand for long content), a relative timestamp, and a **sent-by-me vs received** distinction (alignment + a subtle role label/icon and/or accent).
- **Copy:** **tap/click the whole row to copy** (large target) with explicit **"copied ✓"** feedback (toast + inline check animation). The tiny per-row Copy button is removed; desktop may keep a lightweight hover affordance.
- **Delete / clear:** per-item delete (swipe on mobile / hover action on desktop) and a **clear history** action (header/panel overflow, with confirmation). Both operate on the local encrypted `localStorage` history only.
- **States:**
  - **First-run / empty:** a friendly, instructive empty state explaining the model ("Turn on Sync, then copy anything — it appears here on your other devices").
  - **Connected-but-empty** is distinct from first-run.

## 7. Supporting components

- **Share modal:** keep QR + link + copy, restyled to the system; reinforce the Mode-A "secret lives in the link" message; keep the accessibility fixes; add copied feedback.
- **Toasts:** restyle to the design system (success / warn / error). On mobile, move to **bottom-center** to avoid overlapping the bottom action bar.
- **Theme toggle:** a header control cycling light / dark / system; persisted.

## 8. Component / file structure (codebase)

- **New:** `src/lib/theme.ts` (theme store + persistence + system-pref reaction); `src/app.css` expanded with `@theme` tokens and base styles for both themes.
- **New components:** `theme-toggle.svelte`, `status-pill.svelte`, `mode-chip.svelte`, `sync-toggle.svelte`, `item-row.svelte` (extracted from `items-list.svelte`), `empty-state.svelte`.
- **Restyled (behavior preserved):** `landing.svelte`, `room.svelte`, `header.svelte`, `items-list.svelte`, `share-modal.svelte`, `toast.svelte`.
- **Untouched logic:** `client-core`, `lib/persist.ts`, `lib/clipboard.ts` (`ClipboardWatcher`), `lib/router.ts`, `lib/qr.ts`. New affordances (delete/clear) call existing `PersistedItems` methods or add small ones (e.g. `remove(id)`); no protocol/crypto impact.

## 9. Accessibility & responsiveness

- WCAG-AA contrast in both themes; visible focus states; keyboard operability (the share modal's a11y fixes set the bar — dialogs focusable, Escape closes).
- Touch targets ≥ 44px in the thumb zone.
- Respect `prefers-reduced-motion` and `prefers-color-scheme`.

## 10. Success criteria

- Both themes render coherently; the toggle persists and avoids FOUC.
- A first-time user understands "turn on Sync → copy → it appears elsewhere" from the room screen alone.
- Connection status and security mode are legible at a glance on a phone.
- All four affordances work (tap-to-copy + feedback, sent/received, onboarding/empty, delete/clear).
- `pnpm typecheck` (svelte-check) and the existing web unit + e2e suites stay green; no logic regressions.

## 11. Handoff to `frontend-design`

`frontend-design` owns: the exact accent color(s) and full palette (proposing 2–3 candidates), final contrast tuning, motion specifics, iconography/illustration, and high-fidelity rendering of every screen and state described above. This spec is the brief; structure, hierarchy, states, and behavior here are fixed.

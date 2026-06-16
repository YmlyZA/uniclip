<script lang="ts">
  import { navigateHome } from "../lib/router";
  import StatusPill from "./status-pill.svelte";
  import ModeChip from "./mode-chip.svelte";
  import ThemeToggle from "./theme-toggle.svelte";

  let {
    roomId,
    mode,
    peerCount,
    status,
    ephemeral = false,
    onShare,
    onClear,
    onEnd,
  }: {
    roomId: string;
    mode: "A" | "B";
    peerCount: number;
    status: "connecting" | "connected" | "reconnecting" | "disconnected";
    ephemeral?: boolean;
    onShare: () => void;
    onClear: () => void;
    onEnd: () => void;
  } = $props();

  let menuOpen = $state(false);
</script>

<svelte:window onclick={() => (menuOpen = false)} />

<header
  class="sticky top-0 z-30 border-b border-border bg-bg/80 px-4 py-3 backdrop-blur-md sm:px-6"
>
  <div class="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-2">
    <a href="/" class="flex items-center gap-2 font-display text-lg font-extrabold tracking-tight text-text">
      <span class="grid h-7 w-7 place-items-center rounded-field bg-accent text-accent-fg">
        <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true">
          <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" stroke="currentColor" stroke-width="1.9" />
          <path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5" stroke="currentColor" stroke-width="1.9" />
        </svg>
      </span>
      uniclip
    </a>

    <span class="hidden items-center gap-1.5 rounded-field border border-border bg-surface-2 px-2 py-1 font-mono text-xs text-muted sm:inline-flex">
      <span class="text-faint">room</span>
      <span class="font-semibold text-text">{roomId}</span>
    </span>

    {#if ephemeral}
      <span
        class="inline-flex items-center gap-1 rounded-field border border-warn/40 bg-warn-soft px-2 py-1 text-[11px] font-semibold text-warn"
        title="Nothing is saved on any device; items vanish after 60s"
      >
        <svg viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5" aria-hidden="true">
          <path d="M7 4h10M7 20h10M8 4c0 5 8 5 8 0M8 20c0-5 8-5 8 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        Ephemeral · not saved
      </span>
    {/if}

    <div class="ml-auto flex items-center gap-2">
      <StatusPill {status} />
      <span class="inline-flex items-center gap-1 text-xs text-muted" title="Devices online">
        <svg viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5" aria-hidden="true">
          <circle cx="9" cy="8" r="3" stroke="currentColor" stroke-width="1.7" />
          <path d="M3.5 19a5.5 5.5 0 0 1 11 0" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
          <path d="M16 6a3 3 0 0 1 0 5.5M16.5 19a5.5 5.5 0 0 0-2-4.3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
        </svg>
        {peerCount}
      </span>
      <span class="hidden sm:inline-flex"><ModeChip {mode} /></span>

      <ThemeToggle />

      <button
        type="button"
        onclick={onShare}
        class="grid h-9 w-9 place-items-center rounded-field border border-border bg-surface text-muted transition hover:border-border-strong hover:text-text"
        title="Share room"
        aria-label="Share room"
      >
        <svg viewBox="0 0 24 24" fill="none" class="h-[18px] w-[18px]" aria-hidden="true">
          <circle cx="6" cy="12" r="2.4" stroke="currentColor" stroke-width="1.7" />
          <circle cx="17" cy="6" r="2.4" stroke="currentColor" stroke-width="1.7" />
          <circle cx="17" cy="18" r="2.4" stroke="currentColor" stroke-width="1.7" />
          <path d="M8.1 11l6.8-3.8M8.1 13l6.8 3.8" stroke="currentColor" stroke-width="1.7" />
        </svg>
      </button>

      <div class="relative">
        <button
          type="button"
          onclick={(e) => {
            e.stopPropagation();
            menuOpen = !menuOpen;
          }}
          class="grid h-9 w-9 place-items-center rounded-field border border-border bg-surface text-muted transition hover:border-border-strong hover:text-text"
          title="More"
          aria-label="More actions"
          aria-haspopup="true"
          aria-expanded={menuOpen}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" class="h-[18px] w-[18px]" aria-hidden="true">
            <circle cx="12" cy="5" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="12" cy="19" r="1.7" />
          </svg>
        </button>

        {#if menuOpen}
          <div
            class="absolute right-0 top-11 z-40 w-48 overflow-hidden rounded-card border border-border bg-elevated shadow-[var(--shadow-card)]"
            style="animation: item-arrive 0.16s ease-out"
          >
            <div class="border-b border-border px-3 py-2 sm:hidden">
              <ModeChip {mode} />
            </div>
            <button
              type="button"
              onclick={() => { menuOpen = false; onClear(); }}
              class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-text transition hover:bg-surface-2"
            >
              <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4 text-muted" aria-hidden="true">
                <path d="M5 7h14M10 7V5h4v2M8 7l.8 12h6.4L16 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              Clear history
            </button>
            <button
              type="button"
              onclick={() => { menuOpen = false; onEnd(); navigateHome(); }}
              class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm text-danger transition hover:bg-danger-soft"
            >
              <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true">
                <path d="M15 4h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-2M10 8l-4 4 4 4M6 12h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              End room
            </button>
          </div>
        {/if}
      </div>
    </div>
  </div>
</header>

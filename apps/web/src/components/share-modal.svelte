<script lang="ts">
  import { onMount } from "svelte";
  import { renderQrSvg } from "../lib/qr";

  let { url, mode, onClose }: { url: string; mode: "A" | "B"; onClose: () => void } = $props();
  let svg = $state("");
  let tab = $state<"qr" | "link">("qr");
  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  onMount(async () => {
    svg = await renderQrSvg(url);
  });

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
      clearTimeout(timer);
      timer = setTimeout(() => (copied = false), 1600);
    } catch {}
  }

  function onWindowKey(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<!-- Backdrop click-to-close is a convenience; keyboard users close via Escape
     (window handler above) or the Done button. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="scrim fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
  style="animation: item-arrive 0.18s ease-out"
>
  <div
    class="w-full max-w-sm overflow-hidden rounded-card border border-border bg-elevated shadow-[var(--shadow-card)]"
    role="dialog"
    aria-modal="true"
    aria-label="Share this room"
    tabindex="-1"
  >
    <div class="flex items-center justify-between border-b border-border px-5 py-3.5">
      <h2 class="font-display text-base font-bold text-text">Share this room</h2>
      <button
        type="button"
        onclick={onClose}
        class="grid h-8 w-8 place-items-center rounded-field text-muted transition hover:bg-surface-2 hover:text-text"
        aria-label="Close"
      >
        <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <!-- segmented QR / Link toggle -->
    <div class="flex gap-1 p-3 pb-0">
      <button
        type="button"
        onclick={() => (tab = "qr")}
        class="flex-1 rounded-field px-3 py-1.5 text-sm font-medium transition {tab === 'qr'
          ? 'bg-accent-soft text-accent'
          : 'text-muted hover:text-text'}"
        aria-pressed={tab === "qr"}
      >
        QR code
      </button>
      <button
        type="button"
        onclick={() => (tab = "link")}
        class="flex-1 rounded-field px-3 py-1.5 text-sm font-medium transition {tab === 'link'
          ? 'bg-accent-soft text-accent'
          : 'text-muted hover:text-text'}"
        aria-pressed={tab === "link"}
      >
        Link
      </button>
    </div>

    <div class="p-5">
      {#if tab === "qr"}
        <div class="mx-auto grid w-fit place-items-center rounded-card border border-border bg-white p-3 [&>svg]:h-52 [&>svg]:w-52">
          {@html svg}
        </div>
        <p class="mt-3 text-center text-xs text-muted">Scan with another device's camera.</p>
      {:else}
        <div class="mb-3 break-all rounded-field border border-border bg-surface-2 p-2.5 font-mono text-xs text-muted">
          {url}
        </div>
        <button
          type="button"
          onclick={copy}
          class="flex w-full items-center justify-center gap-2 rounded-field bg-accent px-4 py-2.5 text-sm font-bold text-accent-fg transition hover:bg-accent-bright"
        >
          {#if copied}
            <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true">
              <path d="M5 12.5l4 4 10-10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            Copied to clipboard
          {:else}
            Copy link
          {/if}
        </button>
      {/if}

      <p class="mt-3 flex items-start gap-2 text-xs leading-snug text-muted">
        <svg viewBox="0 0 24 24" fill="none" class="mt-px h-3.5 w-3.5 shrink-0 {mode === 'A' ? 'text-accent' : 'text-warn'}" aria-hidden="true">
          <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" stroke-width="1.7" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="1.7" />
        </svg>
        {#if mode === "A"}
          The decryption secret rides in the link's <span class="font-mono">#fragment</span> — anyone with this link (or QR) can read the room, but the server can't.
        {:else}
          This is a <span class="font-medium text-warn">less secure</span> room: the server can decrypt. Share over a trusted channel.
        {/if}
      </p>
    </div>
  </div>
</div>

<style>
  /* Tailwind's bg-black/55 compiles to a color-mix() with no plain-color
     fallback (transparent on Safari < 16.2), and backdrop-blur-sm omits the
     -webkit- prefix Safari needs — so on Safari/iOS the scrim was see-through.
     A plain rgba() + prefixed blur covers the page reliably everywhere. */
  .scrim {
    background-color: rgba(8, 10, 14, 0.82);
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
  }
</style>

<script lang="ts">
  import { portal } from "../lib/portal";

  let {
    text = $bindable(""),
    over,
    bytes,
    pendingFile = null,
    onFill,
    onSend,
    onClearPending,
    onClose,
  }: {
    text: string;
    over: boolean;
    bytes: number;
    pendingFile?: File | null;
    onFill: () => void;
    onSend: () => void;
    onClearPending?: () => void;
    onClose: () => void;
  } = $props();

  function humanSize(n: number): string {
    return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  let area = $state<HTMLTextAreaElement>();
  $effect(() => {
    area?.focus();
  });

  function onWindowKey(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }
  function kb(n: number): string {
    return (n / 1024).toFixed(n < 10240 ? 1 : 0);
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  use:portal
  class="scrim fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
  style="animation: item-arrive 0.18s ease-out"
>
  <div
    class="flex max-h-[80dvh] w-full max-w-xl flex-col overflow-hidden rounded-card border border-border bg-elevated shadow-[var(--shadow-card)]"
    role="dialog"
    aria-modal="true"
    aria-label="Compose message"
    tabindex="-1"
  >
    <div class="flex items-center justify-between border-b border-border px-5 py-3.5">
      <h2 class="font-display text-base font-bold text-text">Compose</h2>
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

    {#if pendingFile}
      <div class="flex items-center gap-2 border-b border-border px-5 py-2.5">
        <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4 shrink-0 text-accent" aria-hidden="true">
          <rect x="4" y="4" width="16" height="16" rx="2.5" stroke="currentColor" stroke-width="1.7" />
          <circle cx="9" cy="9" r="1.6" stroke="currentColor" stroke-width="1.5" />
          <path d="M5 16l4-4 3 3 3-4 4 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="min-w-0 flex-1 truncate text-xs text-text">{pendingFile.name}</span>
        <span class="shrink-0 text-[11px] text-faint">{humanSize(pendingFile.size)}</span>
        <button
          type="button"
          onclick={() => onClearPending?.()}
          class="grid h-6 w-6 shrink-0 place-items-center rounded-field text-faint transition hover:bg-surface-2 hover:text-danger"
          title="Remove"
          aria-label="Remove staged file"
        >
          <svg viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
        </button>
      </div>
    {/if}

    <textarea
      bind:this={area}
      bind:value={text}
      placeholder="Type or paste…"
      class="min-h-48 flex-1 resize-none bg-transparent p-5 font-mono text-sm leading-relaxed text-text placeholder:font-sans placeholder:text-faint focus:outline-none"
    ></textarea>

    <div class="flex items-center gap-3 border-t border-border p-3">
      <button
        type="button"
        onclick={onFill}
        class="rounded-field border border-border px-3 py-1.5 text-sm text-muted transition hover:border-border-strong hover:text-text"
      >
        Fill from clipboard
      </button>
      <span class="ml-auto text-[11px] {over ? 'text-danger' : 'text-faint'}">{kb(bytes)} KB / 32 KB</span>
      <button
        type="button"
        onclick={onSend}
        disabled={(!text.trim() && !pendingFile) || over}
        class="rounded-field bg-accent px-4 py-1.5 text-sm font-bold text-accent-fg transition hover:bg-accent-bright disabled:opacity-40"
      >
        Send
      </button>
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

<script lang="ts">
  import type { Item } from "../lib/persist";
  import { clipSegments, firstUrl } from "../lib/clip-content";
  import QrPopover from "./qr-popover.svelte";

  let {
    item,
    mine,
    onCopy,
    onDelete,
    onPin = () => {},
  }: {
    item: Item;
    mine: boolean;
    onCopy: (text: string) => void;
    onDelete: (id: string) => void;
    onPin?: (id: string, pinned: boolean) => void;
  } = $props();

  const segments = $derived(clipSegments(item.text));
  const url = $derived(firstUrl(item.text));
  let copied = $state(false);
  let showQr = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function copy() {
    onCopy(item.text);
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), 1400);
  }
  function onContentKey(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); copy(); }
  }
  function ago(ts: number): string {
    const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${Math.round(s / 3600)}h`;
  }
</script>

<div class="group/row flex items-stretch gap-1.5" style="animation: item-arrive 0.28s ease-out" class:flex-row-reverse={mine}>
  <div
    class="relative min-w-0 max-w-[88%] flex-1 overflow-hidden rounded-card border px-3.5 py-2.5 text-left transition
      {item.pending ? 'opacity-60' : ''}
      {mine ? 'border-accent/30 bg-accent-soft' : 'border-border bg-surface hover:border-border-strong'}"
  >
    <div class="flex items-center gap-2 text-[11px]">
      <span class="font-medium uppercase tracking-wide {mine ? 'text-accent' : 'text-faint'}">{mine ? "You" : "Peer"}</span>
      <span class="text-faint">· {ago(item.ts)} ago</span>
      {#if item.pinned}
        <span class="inline-flex items-center gap-1 text-accent" title="Pinned — kept past the history limit">
          <svg viewBox="0 0 24 24" fill="currentColor" class="h-3 w-3" aria-hidden="true"><path d="M9 3h6l-1 6 3 3v2h-5v5l-1 2-1-2v-5H5v-2l3-3z"/></svg>
        </span>
      {/if}
      {#if item.pending}
        <span class="inline-flex items-center gap-1 text-warn" title="Queued — will send when reconnected">
          <svg viewBox="0 0 24 24" fill="none" class="h-3 w-3" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.8"/><path d="M12 8v4l2.5 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Queued
        </span>
      {/if}
    </div>

    <!-- Click anywhere on the content copies; links open instead (stopPropagation). -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      data-testid="clip"
      role="button"
      tabindex="0"
      title="Click to copy"
      onclick={copy}
      onkeydown={onContentKey}
      class="mt-1.5 cursor-pointer whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-text line-clamp-6"
    >
      {#each segments as seg}
        {#if seg.type === "url"}
          <a href={seg.value} target="_blank" rel="noopener noreferrer" onclick={(e) => e.stopPropagation()} class="text-accent underline underline-offset-2 hover:text-accent-bright">{seg.value}</a>
        {:else}{seg.value}{/if}
      {/each}
    </div>

    <!-- action row -->
    <div class="mt-2 flex items-center gap-1 text-faint">
      <button type="button" onclick={copy} title="Copy" aria-label="Copy" class="grid h-7 w-7 place-items-center rounded-field transition hover:bg-surface-2 hover:text-text">
        <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M5 15V5a2 2 0 0 1 2-2h8" stroke="currentColor" stroke-width="1.6"/></svg>
      </button>
      <button type="button" onclick={() => onPin(item.id, !item.pinned)} title={item.pinned ? "Unpin" : "Pin"} aria-label={item.pinned ? "Unpin item" : "Pin item"} aria-pressed={!!item.pinned} class="grid h-7 w-7 place-items-center rounded-field transition hover:bg-surface-2 {item.pinned ? 'text-accent' : 'hover:text-text'}">
        <svg viewBox="0 0 24 24" fill={item.pinned ? "currentColor" : "none"} class="h-4 w-4" aria-hidden="true"><path d="M9 3h6l-1 6 3 3v2h-5v5l-1 2-1-2v-5H5v-2l3-3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
      </button>
      {#if url}
        <a href={url} target="_blank" rel="noopener noreferrer" title="Open link" aria-label="Open link" class="grid h-7 w-7 place-items-center rounded-field transition hover:bg-surface-2 hover:text-text">
          <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M11 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </a>
        <button type="button" onclick={() => (showQr = true)} title="Show QR" aria-label="Show QR code for link" class="grid h-7 w-7 place-items-center rounded-field transition hover:bg-surface-2 hover:text-text">
          <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="4" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.6"/><rect x="4" y="14" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.6"/><path d="M14 14h3v3M20 14v6M17 20h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>
      {/if}
      <button type="button" onclick={() => onDelete(item.id)} title="Delete from this device" aria-label="Delete item" class="ml-auto grid h-7 w-7 place-items-center rounded-field transition hover:bg-danger-soft hover:text-danger">
        <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M8 7l.8 12h6.4L16 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>

    {#if copied}
      <div class="pointer-events-none absolute inset-0 grid place-items-center rounded-card bg-accent-soft backdrop-blur-[1px]" style="animation: copied-pop 0.2s ease-out">
        <span class="flex items-center gap-1.5 text-sm font-semibold text-accent">
          <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true"><path d="M5 12.5l4 4 10-10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Copied
        </span>
      </div>
    {/if}
  </div>
</div>

{#if showQr && url}
  <QrPopover {url} onClose={() => (showQr = false)} />
{/if}

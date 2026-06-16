<script lang="ts">
  import type { Item } from "../lib/persist";

  let {
    item,
    mine,
    onCopy,
    onDelete,
  }: {
    item: Item;
    mine: boolean;
    onCopy: (text: string) => void;
    onDelete: (id: string) => void;
  } = $props();

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function copy() {
    onCopy(item.text);
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), 1400);
  }

  function ago(ts: number): string {
    const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${Math.round(s / 3600)}h`;
  }
</script>

<div
  class="group/row flex items-stretch gap-1.5"
  style="animation: item-arrive 0.28s ease-out"
  class:flex-row-reverse={mine}
>
  <button
    type="button"
    onclick={copy}
    title="Click to copy"
    class="relative min-w-0 max-w-[88%] flex-1 overflow-hidden rounded-card border px-3.5 py-2.5 text-left transition
      {item.pending ? 'opacity-60' : ''}
      {mine
      ? 'border-accent/30 bg-accent-soft'
      : 'border-border bg-surface hover:border-border-strong'}"
  >
    <div class="flex items-center gap-2 text-[11px]">
      <span
        class="font-medium uppercase tracking-wide {mine ? 'text-accent' : 'text-faint'}"
      >
        {mine ? "You" : "Peer"}
      </span>
      <span class="text-faint">· {ago(item.ts)} ago</span>
      {#if item.pending}
        <span class="inline-flex items-center gap-1 text-warn" title="Queued — will send when reconnected">
          <svg viewBox="0 0 24 24" fill="none" class="h-3 w-3" aria-hidden="true">
            <circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.8" />
            <path d="M12 8v4l2.5 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          Queued
        </span>
      {/if}
      <span class="ml-auto flex items-center gap-1 text-faint transition group-hover/row:text-muted">
        <svg viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6" />
          <path d="M5 15V5a2 2 0 0 1 2-2h8" stroke="currentColor" stroke-width="1.6" />
        </svg>
        Copy
      </span>
    </div>
    <div
      data-testid="clip"
      class="mt-1.5 whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-text line-clamp-6"
    >
      {item.text}
    </div>

    {#if copied}
      <div
        class="pointer-events-none absolute inset-0 grid place-items-center rounded-card bg-accent-soft backdrop-blur-[1px]"
        style="animation: copied-pop 0.2s ease-out"
      >
        <span class="flex items-center gap-1.5 text-sm font-semibold text-accent">
          <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true">
            <path d="M5 12.5l4 4 10-10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          Copied
        </span>
      </div>
    {/if}
  </button>

  <button
    type="button"
    onclick={() => onDelete(item.id)}
    title="Delete from this device"
    aria-label="Delete item"
    class="grid w-8 shrink-0 place-items-center rounded-field text-faint transition hover:bg-danger-soft hover:text-danger"
  >
    <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true">
      <path d="M5 7h14M10 7V5h4v2M8 7l.8 12h6.4L16 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
</div>

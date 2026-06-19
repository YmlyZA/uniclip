<script lang="ts">
  import { onDestroy } from "svelte";
  import type { TransferItem } from "../lib/transfers";
  import { toast } from "../lib/toast";
  import { copyImageToClipboard } from "../lib/image-copy";
  import { mediaKind } from "../lib/media-kind";

  let {
    item,
    onAccept,
    onDecline,
    onCancel,
  }: {
    item: TransferItem;
    onAccept: (id: string) => void;
    onDecline: (id: string) => void;
    onCancel: (id: string) => void;
  } = $props();

  let objectUrl = $state<string | undefined>(undefined);
  $effect(() => {
    if (item.state === "done" && item.blob && !objectUrl) {
      objectUrl = URL.createObjectURL(item.blob);
    }
  });
  onDestroy(() => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });

  const kind = $derived(mediaKind(item.mime));
  const pct = $derived(item.total > 0 ? Math.min(100, Math.round((item.sent / item.total) * 100)) : 0);

  function human(n: number): string {
    return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  async function copyImage() {
    if (!item.blob) return;
    try {
      await copyImageToClipboard(item.blob);
      toast("Image copied", "info", 1200);
    } catch {
      toast("Copy image not supported here", "warn");
    }
  }
</script>

<div class="group/row flex items-stretch gap-1.5" style="animation: item-arrive 0.28s ease-out" class:flex-row-reverse={item.mine}>
  <div
    class="min-w-0 max-w-[88%] flex-1 overflow-hidden rounded-card border px-3.5 py-2.5 text-left
      {item.mine ? 'border-accent/30 bg-accent-soft' : 'border-border bg-surface'}"
  >
    <div class="flex items-center gap-2 text-[11px]">
      <span class="font-medium uppercase tracking-wide {item.mine ? 'text-accent' : 'text-faint'}">{item.mine ? "You" : "Peer"}</span>
      <span class="truncate text-muted">{item.name}</span>
      <span class="ml-auto shrink-0 text-faint">{human(item.size)}</span>
    </div>

    {#if item.state === "offering"}
      <div class="mt-2 flex items-center gap-2">
        <button type="button" onclick={() => onAccept(item.fileId)} class="rounded-field bg-accent px-3 py-1 text-xs font-bold text-accent-fg transition hover:bg-accent-bright">Accept</button>
        <button type="button" onclick={() => onDecline(item.fileId)} class="rounded-field border border-border px-3 py-1 text-xs font-medium text-muted transition hover:text-text">Decline</button>
      </div>
    {:else if item.state === "transferring"}
      <div class="mt-2 flex items-center gap-2">
        <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
          <div class="h-full rounded-full bg-accent transition-[width] duration-200" style="width: {pct}%"></div>
        </div>
        <span class="shrink-0 text-[11px] text-faint">{pct}%</span>
        <button type="button" onclick={() => onCancel(item.fileId)} class="shrink-0 text-faint transition hover:text-danger" title="Cancel" aria-label="Cancel transfer">
          <svg viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
        </button>
      </div>
    {:else if item.state === "done"}
      {#if objectUrl}
        {#if kind === "image"}
          <img data-testid="transfer-thumb" src={objectUrl} alt={item.name} class="mt-2 max-h-48 rounded-field border border-border object-contain" />
        {:else if kind === "video"}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video data-testid="transfer-video" src={objectUrl} controls class="mt-2 max-h-64 w-full rounded-field border border-border bg-black"></video>
        {:else if kind === "audio"}
          <audio data-testid="transfer-audio" src={objectUrl} controls class="mt-2 w-full"></audio>
        {/if}
      {/if}
      <div class="mt-2 flex flex-wrap items-center gap-2">
        {#if objectUrl && kind === "openable"}
          <!-- Browser previews it natively (PDF/text/JSON) in a new tab — the
               consistent "preview, don't force-download" behaviour for openable types. -->
          <a data-testid="transfer-open" href={objectUrl} target="_blank" rel="noopener" class="rounded-field bg-accent px-3 py-1 text-xs font-bold text-accent-fg transition hover:bg-accent-bright">Open</a>
        {/if}
        {#if objectUrl}
          <a
            data-testid="transfer-download"
            href={objectUrl}
            download={item.name}
            class="rounded-field px-3 py-1 text-xs font-bold transition
              {kind === 'openable'
              ? 'border border-border text-muted hover:text-text'
              : 'bg-accent text-accent-fg hover:bg-accent-bright'}"
          >Download</a>
        {/if}
        {#if kind === "image" && item.blob}
          <button type="button" onclick={copyImage} class="rounded-field border border-border px-3 py-1 text-xs font-medium text-muted transition hover:text-text">Copy image</button>
        {/if}
        {#if item.mine && !item.blob}
          <span class="inline-flex items-center gap-1 text-xs font-medium text-accent">
            <svg viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5" aria-hidden="true"><path d="M5 12.5l4 4 10-10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
            Sent
          </span>
        {/if}
      </div>
    {:else if item.state === "error"}
      <div class="mt-1 text-xs text-danger">Transfer failed{item.errorMsg ? ` — ${item.errorMsg}` : ""}</div>
    {:else}
      <div class="mt-1 text-xs text-faint">Cancelled</div>
    {/if}
  </div>
</div>

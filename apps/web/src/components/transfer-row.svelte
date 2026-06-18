<script lang="ts">
  import { onDestroy } from "svelte";
  import type { TransferItem } from "../lib/transfers";
  import { toast } from "../lib/toast";

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

  const isImage = $derived(item.mime.startsWith("image/"));
  const pct = $derived(item.total > 0 ? Math.min(100, Math.round((item.sent / item.total) * 100)) : 0);

  function human(n: number): string {
    return n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  async function copyImage() {
    if (!item.blob) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ [item.blob.type]: item.blob })]);
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
      {#if isImage && objectUrl}
        <img data-testid="transfer-thumb" src={objectUrl} alt={item.name} class="mt-2 max-h-48 rounded-field border border-border object-contain" />
      {/if}
      <div class="mt-2 flex items-center gap-2">
        {#if objectUrl}
          <a data-testid="transfer-download" href={objectUrl} download={item.name} class="rounded-field bg-accent px-3 py-1 text-xs font-bold text-accent-fg transition hover:bg-accent-bright">Download</a>
        {/if}
        {#if isImage && item.blob}
          <button type="button" onclick={copyImage} class="rounded-field border border-border px-3 py-1 text-xs font-medium text-muted transition hover:text-text">Copy image</button>
        {/if}
      </div>
    {:else if item.state === "error"}
      <div class="mt-1 text-xs text-danger">Transfer failed{item.errorMsg ? ` — ${item.errorMsg}` : ""}</div>
    {:else}
      <div class="mt-1 text-xs text-faint">Cancelled</div>
    {/if}
  </div>
</div>

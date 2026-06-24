<script lang="ts">
  import ItemRow from "./item-row.svelte";
  import TransferRow from "./transfer-row.svelte";
  import EmptyState from "./empty-state.svelte";
  import type { Item } from "../lib/persist";
  import type { TransferItem } from "../lib/transfers";
  import { matchesQuery } from "../lib/clip-content";

  type Entry = Item | TransferItem;

  let {
    items,
    transfers = [],
    syncing,
    query = "",
    onCopy,
    onDelete,
    onPin = () => {},
    onAccept = () => {},
    onDecline = () => {},
    onCancelTransfer = () => {},
  }: {
    items: Item[];
    transfers?: TransferItem[];
    syncing: boolean;
    query?: string;
    onCopy: (text: string) => void;
    onDelete: (id: string) => void;
    onPin?: (id: string, pinned: boolean) => void;
    onAccept?: (id: string) => void;
    onDecline?: (id: string) => void;
    onCancelTransfer?: (id: string) => void;
  } = $props();

  // One timeline, oldest→newest by ts; filtered by query; the render reverses to newest-first.
  const timeline = $derived<Entry[]>(
    [...items, ...transfers]
      .filter((e) => (isTransfer(e) ? matchesQuery(e.name, query) : matchesQuery(e.text, query)))
      .sort((a, b) => a.ts - b.ts),
  );

  function isTransfer(e: Entry): e is TransferItem {
    return "state" in e && "fileId" in e;
  }
</script>

{#if timeline.length === 0}
  {#if query.trim() === ""}
    <EmptyState {syncing} />
  {:else}
    <p class="px-1 py-8 text-center text-sm text-muted">No items match "{query}".</p>
  {/if}
{:else}
  <div class="space-y-2.5 pb-2">
    {#each timeline.slice().reverse() as entry (isTransfer(entry) ? entry.fileId : entry.id)}
      {#if isTransfer(entry)}
        <TransferRow item={entry} {onAccept} {onDecline} onCancel={onCancelTransfer} />
      {:else}
        <ItemRow item={entry} mine={!!entry.mine} {onCopy} {onDelete} {onPin} />
      {/if}
    {/each}
  </div>
{/if}

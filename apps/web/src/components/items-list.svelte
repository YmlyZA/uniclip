<script lang="ts">
  import ItemRow from "./item-row.svelte";
  import TransferRow from "./transfer-row.svelte";
  import EmptyState from "./empty-state.svelte";
  import type { Item } from "../lib/persist";
  import type { TransferItem } from "../lib/transfers";

  type Entry = Item | TransferItem;

  let {
    items,
    transfers = [],
    syncing,
    onCopy,
    onDelete,
    onAccept = () => {},
    onDecline = () => {},
    onCancelTransfer = () => {},
  }: {
    items: Item[];
    transfers?: TransferItem[];
    syncing: boolean;
    onCopy: (text: string) => void;
    onDelete: (id: string) => void;
    onAccept?: (id: string) => void;
    onDecline?: (id: string) => void;
    onCancelTransfer?: (id: string) => void;
  } = $props();

  // One timeline, oldest→newest by ts; the render reverses to newest-first.
  const timeline = $derived<Entry[]>([...items, ...transfers].sort((a, b) => a.ts - b.ts));

  function isTransfer(e: Entry): e is TransferItem {
    return "state" in e && "fileId" in e;
  }
</script>

{#if timeline.length === 0}
  <EmptyState {syncing} />
{:else}
  <div class="space-y-2.5 pb-2">
    {#each timeline.slice().reverse() as entry (isTransfer(entry) ? entry.fileId : entry.id)}
      {#if isTransfer(entry)}
        <TransferRow item={entry} {onAccept} {onDecline} onCancel={onCancelTransfer} />
      {:else}
        <ItemRow item={entry} mine={!!entry.mine} {onCopy} {onDelete} />
      {/if}
    {/each}
  </div>
{/if}

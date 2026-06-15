<script lang="ts">
  import ItemRow from "./item-row.svelte";
  import EmptyState from "./empty-state.svelte";
  import type { Item } from "../lib/persist";

  let {
    items,
    syncing,
    onCopy,
    onDelete,
  }: {
    items: Item[];
    syncing: boolean;
    onCopy: (text: string) => void;
    onDelete: (id: string) => void;
  } = $props();
</script>

{#if items.length === 0}
  <EmptyState {syncing} />
{:else}
  <div class="space-y-2.5 pb-2">
    {#each items.slice().reverse() as item (item.id)}
      <ItemRow {item} mine={!!item.mine} {onCopy} {onDelete} />
    {/each}
  </div>
{/if}

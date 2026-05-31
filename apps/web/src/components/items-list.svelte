<script lang="ts">
  import { writeClipboardText } from "../lib/clipboard";
  import { toast } from "../lib/toast";
  import type { Item } from "../lib/persist";

  let { items }: { items: Item[] } = $props();

  async function copy(text: string) {
    try {
      await writeClipboardText(text);
      toast("Copied", "info", 1500);
    } catch {
      toast("Copy failed — clipboard permission?", "warn");
    }
  }

  function ago(ts: number): string {
    const sec = Math.max(1, Math.round((Date.now() - ts) / 1000));
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
    return `${Math.round(sec / 3600)}h ago`;
  }
</script>

<ul class="divide-y">
  {#each items.slice().reverse() as item (item.id)}
    <li class="flex items-start justify-between gap-3 px-4 py-2">
      <div class="min-w-0 flex-1">
        <div class="truncate font-mono text-sm">{item.text}</div>
        <div class="text-xs text-gray-500">{ago(item.ts)}</div>
      </div>
      <button class="rounded border px-2 py-1 text-xs" onclick={() => copy(item.text)}>
        Copy
      </button>
    </li>
  {/each}
  {#if items.length === 0}
    <li class="px-4 py-8 text-center text-sm text-gray-500">
      Nothing yet. Copy something on another device.
    </li>
  {/if}
</ul>

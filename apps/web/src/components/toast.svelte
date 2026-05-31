<script lang="ts">
  import { toasts } from "../lib/toast";
</script>

<div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
  {#each $toasts as t (t.id)}
    <div
      class="rounded px-4 py-2 shadow text-sm
        {t.level === 'error' ? 'bg-red-600 text-white'
        : t.level === 'warn' ? 'bg-yellow-500 text-black'
        : 'bg-gray-900 text-white'}"
    >
      {t.text}
    </div>
  {/each}
</div>

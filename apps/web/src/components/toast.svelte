<script lang="ts">
  import { toasts } from "../lib/toast";
</script>

<div
  class="pointer-events-none fixed bottom-28 left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-xs -translate-x-1/2 flex-col items-center gap-2 sm:bottom-6 sm:left-auto sm:right-6 sm:w-auto sm:translate-x-0 sm:items-end"
>
  {#each $toasts as t (t.id)}
    <div
      class="pointer-events-auto flex items-center gap-2 rounded-field border px-3.5 py-2 text-sm font-medium shadow-[var(--shadow-card)] backdrop-blur-md
        {t.level === 'error'
        ? 'border-danger/40 bg-danger-soft text-danger'
        : t.level === 'warn'
          ? 'border-warn/40 bg-warn-soft text-warn'
          : 'border-border bg-elevated text-text'}"
      style="animation: item-arrive 0.18s ease-out"
    >
      {#if t.level === "info"}
        <span class="h-1.5 w-1.5 rounded-full bg-accent"></span>
      {/if}
      {t.text}
    </div>
  {/each}
</div>

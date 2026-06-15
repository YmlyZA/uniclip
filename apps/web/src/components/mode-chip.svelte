<script lang="ts">
  let { mode, compact = false }: { mode: "A" | "B"; compact?: boolean } = $props();
</script>

{#if mode === "A"}
  <span
    class="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent"
    title="Zero-knowledge: the secret stays in your link and never reaches the server"
  >
    <svg viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" stroke-width="1.7" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="1.7" />
      <circle cx="12" cy="15.5" r="1.4" fill="currentColor" />
    </svg>
    {compact ? "Zero-knowledge" : "Zero-knowledge"}
  </span>
{:else}
  <span
    class="inline-flex items-center gap-1.5 rounded-full border border-warn/40 bg-warn-soft px-2.5 py-1 text-xs font-medium text-warn"
    title="Less secure: the key derives from the room code the server sees — it can decrypt"
  >
    <svg viewBox="0 0 24 24" fill="none" class="h-3.5 w-3.5" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" stroke-width="1.7" />
      <path d="M8 11V8a4 4 0 0 1 7-2.5" stroke="currentColor" stroke-width="1.7" />
      <circle cx="12" cy="15.5" r="1.4" fill="currentColor" />
    </svg>
    Less secure
  </span>
{/if}

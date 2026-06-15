<script lang="ts">
  let { syncing }: { syncing: boolean } = $props();
</script>

<div class="grid place-items-center px-6 py-14 text-center">
  <!-- scanning lock motif -->
  <div class="relative mb-6 grid h-20 w-20 place-items-center rounded-card border border-border bg-surface-2">
    <div class="absolute inset-0 overflow-hidden rounded-card">
      <div
        class="absolute inset-x-0 h-8 bg-gradient-to-b from-transparent via-accent-soft to-transparent"
        style="animation: scan 2.6s ease-in-out infinite"
      ></div>
    </div>
    <svg viewBox="0 0 24 24" fill="none" class="relative h-9 w-9 text-accent" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" stroke-width="1.6" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="1.6" />
      <circle cx="12" cy="15.5" r="1.3" fill="currentColor" />
    </svg>
  </div>

  <h3 class="font-display text-lg font-bold text-text">Nothing here yet</h3>

  {#if syncing}
    <p class="mt-1.5 max-w-xs text-sm text-muted">
      Sync is on. Copy text on this or another device — it appears here, end-to-end encrypted.
    </p>
  {:else}
    <ol class="mt-4 max-w-xs space-y-2 text-left text-sm text-muted">
      <li class="flex gap-2.5">
        <span class="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-bold text-accent">1</span>
        Turn on <span class="font-medium text-text">Sync this device</span>.
      </li>
      <li class="flex gap-2.5">
        <span class="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-bold text-accent">2</span>
        Copy anything — it streams to the room.
      </li>
      <li class="flex gap-2.5">
        <span class="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-bold text-accent">3</span>
        Open the same link on another device.
      </li>
    </ol>
  {/if}
</div>

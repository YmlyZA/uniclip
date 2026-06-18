<script lang="ts">
  import { MAX_FILE_MB } from "../lib/file-send";
</script>

<div
  class="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-bg/70 backdrop-blur-sm"
  style="animation: item-arrive 0.15s ease-out"
  aria-hidden="true"
>
  <div class="rounded-card border-2 border-dashed border-accent bg-surface/80 px-8 py-6 text-center glow-ring">
    <svg viewBox="0 0 24 24" fill="none" class="mx-auto mb-2 h-8 w-8 text-accent" aria-hidden="true">
      <path d="M12 16V4m0 0l-4 4m4-4l4 4M5 20h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <p class="font-display text-lg font-bold text-text">Drop to send</p>
    <p class="mt-0.5 text-xs text-muted">Encrypted end-to-end · max {MAX_FILE_MB} MB</p>
  </div>
</div>

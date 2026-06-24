<script lang="ts">
  import { onMount } from "svelte";
  import { renderQrSvg } from "../lib/qr";
  let { url, onClose }: { url: string; onClose: () => void } = $props();
  let svg = $state("");
  onMount(async () => { svg = await renderQrSvg(url); });
  function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
</script>

<svelte:window onkeydown={onKey} />
<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="scrim fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation"
  onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
  <div class="w-full max-w-xs rounded-card border border-border bg-elevated p-5 shadow-[var(--shadow-card)]" role="dialog" aria-modal="true" aria-label="QR code for link" tabindex="-1">
    <div class="mx-auto grid w-fit place-items-center rounded-card border border-border bg-white p-3 [&>svg]:h-48 [&>svg]:w-48">
      {@html svg}
    </div>
    <p class="mt-3 break-all text-center text-xs text-muted">{url}</p>
    <button type="button" onclick={onClose} class="mt-4 w-full rounded-field bg-accent px-4 py-2 text-sm font-bold text-accent-fg transition hover:bg-accent-bright">Done</button>
  </div>
</div>

<style>
  .scrim {
    background-color: rgba(8, 10, 14, 0.82);
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
  }
</style>

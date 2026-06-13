<script lang="ts">
  import { onMount } from "svelte";
  import { renderQrSvg } from "../lib/qr";

  let { url, onClose }: { url: string; onClose: () => void } = $props();
  let svg = $state("");
  onMount(async () => {
    svg = await renderQrSvg(url);
  });

  async function copy() {
    await navigator.clipboard.writeText(url);
  }

  function onWindowKey(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<!-- Backdrop click-to-close is a convenience; keyboard users close via Escape
     (window handler above) or the Done button. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
>
  <div
    class="w-full max-w-sm rounded bg-white p-6 dark:bg-gray-900"
    role="dialog"
    aria-modal="true"
    aria-label="Share this room"
    tabindex="-1"
  >
    <h2 class="mb-4 text-lg font-semibold">Share this room</h2>
    <div class="mb-3 grid place-items-center">{@html svg}</div>
    <div class="mb-3 break-all rounded bg-gray-100 p-2 font-mono text-xs dark:bg-gray-800">
      {url}
    </div>
    <div class="flex justify-end gap-2">
      <button class="rounded border px-3 py-1 text-sm" onclick={copy}>Copy link</button>
      <button class="rounded bg-black px-3 py-1 text-sm text-white" onclick={onClose}>Done</button>
    </div>
  </div>
</div>

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
</script>

<div
  class="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
  onclick={onClose}
  role="dialog"
>
  <div
    class="w-full max-w-sm rounded bg-white p-6 dark:bg-gray-900"
    onclick={(e) => e.stopPropagation()}
    role="document"
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

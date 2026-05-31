<script lang="ts">
  import { navigateHome } from "../lib/router";

  let {
    roomId,
    peerCount,
    status,
    onShare,
    onEnd,
  }: {
    roomId: string;
    peerCount: number;
    status: string;
    onShare: () => void;
    onEnd: () => void;
  } = $props();
</script>

<header class="flex items-center justify-between border-b px-4 py-3">
  <div>
    <div class="font-semibold">uniclip</div>
    <div class="text-xs text-gray-500">
      Room <span class="font-mono">{roomId}</span> · {peerCount} online · {status}
    </div>
  </div>
  <div class="flex gap-2">
    <button class="rounded border px-3 py-1 text-sm" onclick={onShare}>Share</button>
    <button class="rounded border px-3 py-1 text-sm" onclick={() => { onEnd(); navigateHome(); }}>
      End
    </button>
  </div>
</header>

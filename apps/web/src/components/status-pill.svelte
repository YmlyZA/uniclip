<script lang="ts">
  let { status }: { status: "connecting" | "connected" | "reconnecting" | "disconnected" } =
    $props();

  const meta = {
    connecting: { label: "Connecting", color: "var(--warn)", live: false },
    connected: { label: "Secure channel", color: "var(--ok)", live: true },
    reconnecting: { label: "Reconnecting", color: "var(--warn)", live: false },
    disconnected: { label: "Offline", color: "var(--danger)", live: false },
  } as const;

  let m = $derived(meta[status]);
</script>

<span
  class="inline-flex items-center gap-2 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs font-medium"
>
  <span class="relative flex h-2.5 w-2.5 items-center justify-center">
    {#if m.live}
      <span
        class="absolute inset-0 rounded-full"
        style="background:{m.color};animation:ping 1.7s cubic-bezier(0,0,.2,1) infinite"
      ></span>
    {/if}
    <span class="relative h-2.5 w-2.5 rounded-full" style="background:{m.color}"></span>
  </span>
  <span style="color:{m.color}">{m.label}</span>
</span>

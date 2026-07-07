<script lang="ts">
  let { transport }: { transport: "p2p" | "relay" } = $props();
</script>

<!-- Direct (P2P) = bolt, accent-tinted (the "upgraded" path); Relayed = cloud, muted. -->
<span
  class="grid h-6 w-6 place-items-center {transport === 'p2p' ? 'text-accent' : 'text-faint'}"
  title={transport === "p2p" ? "Direct peer-to-peer (LAN when local)" : "Relayed through the server"}
  aria-label={transport === "p2p" ? "Direct (peer-to-peer)" : "Relayed (through the server)"}
  role="img"
>
  {#if transport === "p2p"}
    <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true">
      <path d="M13 3 5 13h5l-1 8 8-11h-5z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" />
    </svg>
  {:else}
    <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true">
      <path d="M7 18a4 4 0 0 1 .5-8 5 5 0 0 1 9.6 1.4A3.3 3.3 0 0 1 16.5 18Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" />
    </svg>
  {/if}
</span>

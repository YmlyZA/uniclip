<script lang="ts">
  import { onMount } from "svelte";
  import { formatVersion, updateLabel, releasesUrl } from "../lib/version";

  type VersionInfo = { version: string; gitSha: string; latest: string | null; updateAvailable: boolean };
  let info = $state<VersionInfo | null>(null);

  const relayBase = import.meta.env.VITE_RELAY_BASE ?? window.location.origin;

  onMount(async () => {
    try {
      const res = await fetch(`${relayBase}/api/version`);
      if (res.ok) info = (await res.json()) as VersionInfo;
    } catch {
      /* offline / relay down — footer simply doesn't render */
    }
  });

  const label = $derived(info ? updateLabel(info) : null);
</script>

{#if info}
  <footer style="text-align:center;padding:10px;font-size:11px;opacity:0.55;">
    <span>{formatVersion(info)}</span>
    {#if label}
      · <a href={releasesUrl()} target="_blank" rel="noopener" style="color:inherit;">{label}</a>
    {/if}
  </footer>
{/if}

<script lang="ts">
  import { diagToText, candidateCounts, type DiagRow } from "../lib/debug-overlay";

  let { rows = [], transport = "relay", onClose = () => {} }: {
    rows?: DiagRow[];
    transport?: "p2p" | "relay";
    onClose?: () => void;
  } = $props();

  let copied = $state(false);
  const counts = $derived(candidateCounts(rows));

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(diagToText(rows));
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch { /* clipboard denied — no-op */ }
  }

  function levelColor(level: string): string {
    return level === "error" ? "#f87171" : level === "warn" ? "#fbbf24" : "#9ca3af";
  }
</script>

<!-- plain rgba + -webkit- blur: mobile Safari (row B) renders bg-black/NN as transparent -->
<div
  style="position:fixed;right:8px;bottom:8px;width:min(92vw,440px);max-height:50vh;overflow:auto;
         background:rgba(15,15,18,0.92);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);
         color:#e5e7eb;font:11px ui-monospace,Menlo,monospace;border-radius:8px;padding:8px;z-index:9999;"
>
  <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;">
    <span>
      {transport === "p2p" ? "Direct" : "Relayed"}
      · host {counts.host} · srflx {counts.srflx} · relay {counts.relay}
    </span>
    <span style="display:flex;gap:6px;">
      <button onclick={copyAll} style="cursor:pointer;">{copied ? "Copied" : "Copy"}</button>
      <button onclick={onClose} style="cursor:pointer;">×</button>
    </span>
  </div>
  {#each rows as r (r.t + r.phase + r.detail)}
    <div style="white-space:pre;color:{levelColor(r.level)};">
      [{(r.t / 1000).toFixed(2)}s] {r.phase} {r.detail}
    </div>
  {/each}
</div>

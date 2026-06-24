<script lang="ts">
  type Device = { id: string; name: string; self: boolean };
  let { roster, onRename, onClose }: { roster: Device[]; onRename: (name: string) => void; onClose: () => void } = $props();
  const self = $derived(roster.find((d) => d.self));
  const others = $derived(roster.filter((d) => !d.self));
  let editing = $state(false);
  let draft = $state("");

  function startEdit() {
    draft = self?.name ?? "";
    editing = true;
  }
  function save() {
    const name = draft.trim().slice(0, 40);
    if (name) onRename(name);
    editing = false;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="w-64 overflow-hidden rounded-card border border-border bg-elevated p-2 shadow-[var(--shadow-card)]" role="dialog" aria-label="Connected devices" tabindex="-1" onclick={(e) => e.stopPropagation()}>
  <div class="flex items-center justify-between gap-2 rounded-field bg-surface-2 px-3 py-2">
    {#if editing}
      <input
        bind:value={draft}
        maxlength="40"
        class="min-w-0 flex-1 bg-transparent text-sm text-text focus:outline-none"
        onkeydown={(e) => { if (e.key === "Enter") save(); }}
        onblur={save}
        aria-label="Your device name"
      />
    {:else}
      <span class="min-w-0 flex-1 truncate text-sm font-medium text-text">{self?.name}</span>
      <span class="shrink-0 text-[11px] text-accent">This device</span>
      <button type="button" onclick={startEdit} class="shrink-0 text-xs text-muted hover:text-text" aria-label="Rename this device">Edit</button>
    {/if}
  </div>
  {#each others as d (d.id)}
    <div class="flex items-center gap-2 px-3 py-2 text-sm text-text">
      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"></span>
      <span class="min-w-0 flex-1 truncate">{d.name}</span>
    </div>
  {/each}
  {#if others.length === 0}
    <p class="px-3 py-2 text-xs text-muted">Only this device is connected.</p>
  {/if}
</div>

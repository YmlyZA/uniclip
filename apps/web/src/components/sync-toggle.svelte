<script lang="ts">
  let {
    on,
    onToggle,
    hint = "",
  }: { on: boolean; onToggle: () => void; hint?: string } = $props();
</script>

<button
  type="button"
  onclick={onToggle}
  aria-pressed={on}
  class="group relative flex w-full items-center gap-3.5 overflow-hidden rounded-card border px-4 py-3.5 text-left transition
    {on
    ? 'border-accent/50 bg-accent-soft'
    : 'border-border bg-surface hover:border-border-strong'}"
  style={on ? "animation: sync-breathe 3.4s ease-in-out infinite" : ""}
>
  <!-- knob -->
  <span
    class="relative h-7 w-12 shrink-0 rounded-full border transition-colors duration-300
      {on ? 'border-accent bg-accent' : 'border-border-strong bg-surface-2'}"
  >
    <span
      class="absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full shadow-sm transition-all duration-300
        {on ? 'left-[1.55rem] bg-accent-fg' : 'left-1 bg-text/70'}"
    ></span>
  </span>

  <span class="min-w-0 flex-1">
    <span class="flex items-center gap-2 text-sm font-semibold text-text">
      Sync this device
      {#if on}
        <span class="text-glow text-[11px] font-medium uppercase tracking-wider text-accent">live</span>
      {/if}
    </span>
    <span class="mt-0.5 block text-xs text-muted">
      {on ? "Anything you copy flows to the room" : "Off — sending is manual"}
    </span>
    {#if on && hint}
      <span class="mt-1 block text-[11px] leading-snug text-faint">{hint}</span>
    {/if}
  </span>
</button>

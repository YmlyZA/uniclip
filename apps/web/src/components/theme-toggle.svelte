<script lang="ts">
  import { theme, cycleTheme } from "../lib/theme";
  const next = { light: "dark", dark: "system", system: "light" } as const;
</script>

<button
  type="button"
  onclick={cycleTheme}
  class="grid h-9 w-9 place-items-center rounded-field border border-border bg-surface text-muted transition hover:border-border-strong hover:text-text"
  title={`Theme: ${$theme} — switch to ${next[$theme]}`}
  aria-label={`Theme: ${$theme}. Switch to ${next[$theme]}.`}
>
  {#if $theme === "light"}
    <svg viewBox="0 0 24 24" fill="none" class="h-[18px] w-[18px]" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" stroke="currentColor" stroke-width="1.7" />
      <path
        d="M12 2.5v2.5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
      />
    </svg>
  {:else if $theme === "dark"}
    <svg viewBox="0 0 24 24" fill="none" class="h-[18px] w-[18px]" aria-hidden="true">
      <path
        d="M20 14.5A8 8 0 1 1 9.5 4a6.3 6.3 0 0 0 10.5 10.5Z"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linejoin="round"
      />
    </svg>
  {:else}
    <svg viewBox="0 0 24 24" fill="none" class="h-[18px] w-[18px]" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="12" rx="2" stroke="currentColor" stroke-width="1.7" />
      <path d="M8.5 20h7M12 16.5V20" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
    </svg>
  {/if}
</button>

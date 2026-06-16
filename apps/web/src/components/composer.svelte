<script lang="ts">
  import { onMount } from "svelte";
  import { readClipboardText } from "../lib/clipboard";
  import { toast } from "../lib/toast";
  import { MAX_TEXT_BYTES, textByteLength, withinLimit } from "../lib/limits";
  import ComposerModal from "./composer-modal.svelte";

  let { onSend }: { onSend: (text: string) => void } = $props();
  let text = $state("");
  let area = $state<HTMLTextAreaElement>();
  let expanded = $state(false);

  let bytes = $derived(textByteLength(text));
  let over = $derived(bytes > MAX_TEXT_BYTES);
  let showCount = $derived(bytes > MAX_TEXT_BYTES * 0.75);

  onMount(async () => {
    try {
      const t = await readClipboardText();
      if (t && !text) text = t;
    } catch {}
  });

  async function fill() {
    try {
      text = await readClipboardText();
      area?.focus();
    } catch {}
  }

  function send() {
    if (!text.trim()) return;
    if (!withinLimit(text)) {
      toast("Too large to send (max 32 KB). File transfer is coming.", "warn");
      return;
    }
    onSend(text);
    text = "";
    expanded = false;
    area?.focus();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function kb(n: number): string {
    return (n / 1024).toFixed(n < 10240 ? 1 : 0);
  }
</script>

<div class="rounded-card border border-border bg-surface">
  <div class="flex items-center gap-2 p-2">
    <button
      type="button"
      onclick={fill}
      class="grid h-9 w-9 shrink-0 place-items-center rounded-field text-muted transition hover:bg-surface-2 hover:text-text"
      title="Fill from clipboard"
      aria-label="Fill from clipboard"
    >
      <svg viewBox="0 0 24 24" fill="none" class="h-[18px] w-[18px]" aria-hidden="true">
        <rect x="8" y="3" width="8" height="4" rx="1" stroke="currentColor" stroke-width="1.7" />
        <path d="M9 5H6.5A1.5 1.5 0 0 0 5 6.5v13A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-13A1.5 1.5 0 0 0 17.5 5H15" stroke="currentColor" stroke-width="1.7" />
      </svg>
    </button>

    <textarea
      bind:this={area}
      bind:value={text}
      onkeydown={onKeydown}
      rows="1"
      placeholder="Type or paste — Enter to send"
      class="h-9 flex-1 resize-none overflow-hidden whitespace-nowrap bg-transparent py-1.5 font-mono text-sm text-text placeholder:font-sans placeholder:text-faint focus:outline-none"
    ></textarea>

    <button
      type="button"
      onclick={() => (expanded = true)}
      class="grid h-9 w-9 shrink-0 place-items-center rounded-field text-muted transition hover:bg-surface-2 hover:text-text"
      title="Expand editor"
      aria-label="Expand editor"
    >
      <svg viewBox="0 0 24 24" fill="none" class="h-[18px] w-[18px]" aria-hidden="true">
        <path d="M9 4H5a1 1 0 0 0-1 1v4M15 4h4a1 1 0 0 1 1 1v4M9 20H5a1 1 0 0 1-1-1v-4M15 20h4a1 1 0 0 0 1-1v-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <button
      type="button"
      onclick={send}
      disabled={!text.trim() || over}
      class="grid h-9 w-9 shrink-0 place-items-center rounded-field bg-accent text-accent-fg transition hover:bg-accent-bright disabled:opacity-40"
      title="Send"
      aria-label="Send"
    >
      <svg viewBox="0 0 24 24" fill="none" class="h-[18px] w-[18px]" aria-hidden="true">
        <path d="M5 12h13M12 5l7 7-7 7" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  </div>

  {#if showCount}
    <div class="px-3 pb-1.5 text-right text-[11px] {over ? 'text-danger' : 'text-faint'}">
      {kb(bytes)} KB / 32 KB
    </div>
  {/if}
</div>

{#if expanded}
  <ComposerModal bind:text {over} {bytes} onFill={fill} onSend={send} onClose={() => (expanded = false)} />
{/if}

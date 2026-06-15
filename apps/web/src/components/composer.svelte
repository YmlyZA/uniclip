<script lang="ts">
  import { onMount } from "svelte";
  import { readClipboardText } from "../lib/clipboard";

  let { onSend }: { onSend: (text: string) => void } = $props();
  let text = $state("");
  let area = $state<HTMLTextAreaElement>();

  onMount(async () => {
    // Best-effort prefill from the clipboard (works on desktop; mobile needs the
    // explicit fill button or a paste gesture).
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
    onSend(text);
    text = "";
    area?.focus();
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }
</script>

<div class="flex items-end gap-2 rounded-card border border-border bg-surface p-2">
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
    class="max-h-32 min-h-9 flex-1 resize-none bg-transparent py-1.5 font-mono text-sm text-text placeholder:font-sans placeholder:text-faint focus:outline-none"
  ></textarea>

  <button
    type="button"
    onclick={send}
    disabled={!text.trim()}
    class="grid h-9 w-9 shrink-0 place-items-center rounded-field bg-accent text-accent-fg transition hover:bg-accent-bright disabled:opacity-40"
    title="Send"
    aria-label="Send"
  >
    <svg viewBox="0 0 24 24" fill="none" class="h-[18px] w-[18px]" aria-hidden="true">
      <path d="M5 12h13M12 5l7 7-7 7" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
</div>

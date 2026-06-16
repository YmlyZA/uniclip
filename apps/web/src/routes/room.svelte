<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { UniclipClient, deriveRoomKey } from "@uniclip/client-core";
  import type { ParsedRoom } from "@uniclip/room-code";
  import Header from "../components/header.svelte";
  import ItemsList from "../components/items-list.svelte";
  import ShareModal from "../components/share-modal.svelte";
  import Composer from "../components/composer.svelte";
  import SyncToggle from "../components/sync-toggle.svelte";
  import Toaster from "../components/toast.svelte";
  import { writeClipboardText, ClipboardWatcher } from "../lib/clipboard";
  import { PersistedItems, type Item } from "../lib/persist";
  import { toast } from "../lib/toast";

  let { room }: { room: ParsedRoom } = $props();

  const relayBase = (import.meta.env.VITE_RELAY_BASE ?? window.location.origin).replace(
    /^http/,
    "ws",
  );
  const httpBase = import.meta.env.VITE_RELAY_BASE ?? window.location.origin;
  const roomUrl = window.location.href;
  const secretFrag = $derived(room.mode === "A" ? `#${room.secret}` : "");
  const shareUrl = $derived(`${httpBase}/r/${room.routingId}${secretFrag}`);
  const syncHint = "On phones, keep this tab in front — background copies can't be read.";

  let client = $state<UniclipClient | null>(null);
  let items = $state<Item[]>([]);
  let peerCount = $state(1);
  let status = $state<"connecting" | "connected" | "reconnecting" | "disconnected">("connecting");
  let watching = $state(false);
  let showShare = $state(false);
  let backfillOn = $state(false);
  let keyError = $state(false);
  let persist: PersistedItems | null = null;
  const watcher = new ClipboardWatcher({ intervalMs: 1000 });

  onMount(async () => {
    const key = await deriveRoomKey(room);
    persist = new PersistedItems({ roomId: room.routingId, key, cap: 50 });
    items = await persist.load();

    const c = new UniclipClient({ roomUrl, relayBase });
    client = c;
    c.on("status", (s) => (status = s));
    c.on("peer", (n) => (peerCount = n));
    c.on("room", (info) => (backfillOn = info.backfill));
    c.on("clip", async (text, ts, msgId) => {
      await addItem(text, ts, msgId, false);
    });
    c.on("delete", async (msgId) => {
      items = items.filter((i) => i.id !== msgId);
      await persist?.remove(msgId);
    });
    c.on("error", (e) => {
      if (e.code === "DECRYPT_FAILED") keyError = true;
      else toast(`${e.code}: ${e.message}`, "warn");
    });
    await c.connect();

    watcher.on(async (text) => {
      try {
        const { msgId, ts } = await c.send(text);
        await addItem(text, ts, msgId, true);
      } catch {}
    });
  });

  onDestroy(() => {
    watcher.stop();
    client?.disconnect();
  });

  async function addItem(text: string, ts: number, msgId: string, mine: boolean) {
    if (items.some((i) => i.id === msgId)) return;
    const item: Item = { id: msgId, text, ts, mine };
    items = [...items, item].slice(-50);
    await persist!.add(item);
  }

  async function sendText(text: string) {
    try {
      if (!client) return;
      const { msgId, ts } = await client.send(text);
      await addItem(text, ts, msgId, true);
    } catch {
      toast("Send failed", "warn");
    }
  }

  async function copy(text: string) {
    try {
      await writeClipboardText(text);
    } catch {
      toast("Copy failed — clipboard permission?", "warn");
    }
  }

  async function onDelete(id: string) {
    items = items.filter((i) => i.id !== id);
    await persist?.remove(id);
    client?.delete(id);
  }

  function clearHistory() {
    items = [];
    persist?.clear();
    toast("History cleared", "info", 1200);
  }

  async function toggleWatch() {
    if (watching) {
      watcher.stop();
      watching = false;
    } else {
      try {
        await watcher.start();
        watching = true;
      } catch {
        toast("Couldn't start sync — clipboard permission?", "warn");
      }
    }
  }

  function endRoom() {
    persist?.clear();
    client?.disconnect();
  }
</script>

<div class="flex min-h-[100dvh] flex-col">
  <Header
    roomId={room.routingId}
    mode={room.mode}
    {peerCount}
    {status}
    onShare={() => (showShare = true)}
    onClear={clearHistory}
    onEnd={endRoom}
  />

  {#if keyError}
    <div class="border-b border-danger/40 bg-danger-soft px-4 py-2.5 text-sm text-danger sm:px-6">
      <div class="mx-auto flex max-w-5xl items-start gap-2.5">
        <svg viewBox="0 0 24 24" fill="none" class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true">
          <path d="M12 8v5M12 16.5h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>
          <span class="font-semibold">Connected, but can't decrypt this room.</span>
          You likely opened it without the secret (the part after <span class="font-mono">#</span> in the share link). Open the
          <span class="font-semibold">full share link</span> to read and sync.
        </span>
      </div>
    </div>
  {/if}

  <main
    class="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:gap-6 lg:py-6"
  >
    <!-- Desktop control rail -->
    <aside class="hidden w-72 shrink-0 lg:block">
      <div class="sticky top-24 space-y-3">
        <SyncToggle on={watching} onToggle={toggleWatch} hint={syncHint} />
        <Composer onSend={sendText} />

        {#if backfillOn}
          <div class="flex items-start gap-2 rounded-field border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
            <svg viewBox="0 0 24 24" fill="none" class="mt-px h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true">
              <path d="M4 12a8 8 0 0 1 13.7-5.6L20 9M20 12a8 8 0 0 1-13.7 5.6L4 15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
              <path d="M20 5v4h-4M4 19v-4h4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            Recent items are shared with devices that join later.
          </div>
        {/if}

        <div class="rounded-card border border-border bg-surface p-3.5 text-xs leading-relaxed text-muted">
          {#if room.mode === "A"}
            <span class="font-medium text-text">Zero-knowledge.</span> The secret lives only in your link
            and never reaches the server — it can't read your clipboard.
          {:else}
            <span class="font-medium text-warn">Less secure.</span> The key derives from the room code the
            server sees, so the server could decrypt. Share over a trusted channel.
          {/if}
        </div>
      </div>
    </aside>

    <!-- List -->
    <section class="min-w-0 flex-1 pb-44 lg:pb-0">
      <ItemsList {items} syncing={watching} onCopy={copy} {onDelete} />
    </section>
  </main>

  <!-- Mobile bottom action bar (thumb zone) -->
  <div
    class="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-bg/90 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-md lg:hidden"
  >
    <div class="mx-auto flex max-w-5xl flex-col gap-2">
      <SyncToggle on={watching} onToggle={toggleWatch} hint={syncHint} />
      <Composer onSend={sendText} />
    </div>
  </div>

  {#if showShare}
    <ShareModal url={shareUrl} mode={room.mode} onClose={() => (showShare = false)} />
  {/if}

  <Toaster />
</div>

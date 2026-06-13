<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { UniclipClient, deriveRoomKey } from "@uniclip/client-core";
  import type { ParsedRoom } from "@uniclip/room-code";
  import Header from "../components/header.svelte";
  import ItemsList from "../components/items-list.svelte";
  import ShareModal from "../components/share-modal.svelte";
  import Toaster from "../components/toast.svelte";
  import { readClipboardText, ClipboardWatcher } from "../lib/clipboard";
  import { PersistedItems, type Item } from "../lib/persist";
  import { toast } from "../lib/toast";

  let { room }: { room: ParsedRoom } = $props();

  const relayBase = (import.meta.env.VITE_RELAY_BASE ?? window.location.origin).replace(
    /^http/,
    "ws",
  );
  const httpBase = import.meta.env.VITE_RELAY_BASE ?? window.location.origin;
  const roomUrl = window.location.href;

  let client = $state<UniclipClient | null>(null);
  let items = $state<Item[]>([]);
  let peerCount = $state(1);
  let status = $state<"connecting" | "connected" | "reconnecting" | "disconnected">("connecting");
  let watching = $state(false);
  let showShare = $state(false);
  let backfillOn = $state(false);
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
    c.on("room", (b) => (backfillOn = b));
    c.on("clip", async (text, ts, msgId) => {
      await addItem(text, ts, msgId);
    });
    c.on("error", (e) => toast(`${e.code}: ${e.message}`, "warn"));
    await c.connect();

    watcher.on(async (text) => {
      try {
        const { msgId, ts } = await c.send(text);
        await addItem(text, ts, msgId);
      } catch {}
    });
  });

  onDestroy(() => {
    watcher.stop();
    client?.disconnect();
  });

  async function sendNow() {
    try {
      const text = await readClipboardText();
      if (!client) return;
      const { msgId, ts } = await client.send(text);
      await addItem(text, ts, msgId);
    } catch {
      toast("Clipboard read failed — permission?", "warn");
    }
  }

  async function addItem(text: string, ts: number, msgId: string) {
    if (items.some((i) => i.id === msgId)) return; // mirror persist's dedup for the live list
    const item: Item = { id: msgId, text, ts };
    items = [...items, item].slice(-50);
    await persist!.add(item);
  }

  async function toggleWatch() {
    if (watching) {
      watcher.stop();
      watching = false;
    } else {
      await watcher.start();
      watching = true;
    }
  }

  function endRoom() {
    persist?.clear();
    client?.disconnect();
  }
</script>

<Header
  roomId={room.routingId}
  peerCount={peerCount}
  status={status}
  onShare={() => (showShare = true)}
  onEnd={endRoom}
/>

<section class="flex items-center gap-2 border-b px-4 py-2">
  <button class="rounded bg-black px-3 py-1 text-sm text-white" onclick={sendNow}>
    Send clipboard
  </button>
  <button class="rounded border px-3 py-1 text-sm" onclick={toggleWatch}>
    Watch: {watching ? "ON" : "OFF"}
  </button>
  {#if backfillOn}
    <span class="ml-auto text-xs text-gray-500" title="New devices receive recent items while a device stays connected">
      Sharing recent items
    </span>
  {/if}
  {#if room.mode === "B"}
    <span class="{backfillOn ? '' : 'ml-auto'} rounded bg-yellow-100 px-2 py-1 text-xs text-yellow-800">
      Less secure: server can decrypt
    </span>
  {/if}
</section>

<ItemsList items={items} />

{#if showShare}
  <ShareModal url={`${httpBase}/r/${room.routingId}${room.mode === "A" ? "#" + (room as any).secret : ""}`}
    onClose={() => (showShare = false)} />
{/if}

<Toaster />

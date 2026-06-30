<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { UniclipClient, deriveRoomKey } from "@uniclip/client-core";
  import type { ParsedRoom } from "@uniclip/room-code";
  import Header from "../components/header.svelte";
  import ItemsList from "../components/items-list.svelte";
  import ShareModal from "../components/share-modal.svelte";
  import Composer from "../components/composer.svelte";
  import DropOverlay from "../components/drop-overlay.svelte";
  import SyncToggle from "../components/sync-toggle.svelte";
  import Toaster from "../components/toast.svelte";
  import { defaultDeviceName } from "../lib/device-name";
  import { writeClipboardText, ClipboardWatcher } from "../lib/clipboard";
  import { PersistedItems, EphemeralStore, type Item, type ItemStore } from "../lib/persist";
  import { EPHEMERAL_TTL_MS, ExpiryScheduler } from "../lib/ephemeral";
  import {
    addOutgoing, applyOffer, applyProgress, applyReceived, applyError,
    applyCancel, removeTransfer, markTransferring, type TransferItem,
  } from "../lib/transfers";
  import { tooLarge, readFileBytes, MAX_FILE_MB } from "../lib/file-send";
  import { toast } from "../lib/toast";
  import { historyText, downloadTextFile } from "../lib/export";
  import { matchesQuery } from "../lib/clip-content";
  import DebugOverlay from "../components/debug-overlay.svelte";
  import { pushDiag, debugEnabled, type DiagRow } from "../lib/debug-overlay";

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

  function deviceId(): string {
    const k = "uniclip.deviceId";
    let id = sessionStorage.getItem(k);
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(k, id); }
    return id;
  }
  let deviceName = $state(localStorage.getItem("uniclip.deviceName") || defaultDeviceName());
  let roster = $state<{ id: string; name: string; self: boolean }[]>([]);

  let client = $state<UniclipClient | null>(null);
  let items = $state<Item[]>([]);
  let transfers = $state<TransferItem[]>([]);
  let pendingFile = $state<File | null>(null); // staged in the composer until Send/Enter
  let dragDepth = $state(0); // dragenter/leave fire on children; count to know when truly out
  const dragging = $derived(dragDepth > 0);
  let peerCount = $state(1);
  let status = $state<"connecting" | "connected" | "reconnecting" | "disconnected">("connecting");
  let transport = $state<"p2p" | "relay">("relay");
  let diagRows = $state<DiagRow[]>([]);
  let showDebug = $state(debugEnabled(typeof location !== "undefined" ? location.search : ""));
  const diagStart = Date.now();
  let watching = $state(false);
  let showShare = $state(false);
  let backfillOn = $state(false);
  let keyError = $state(false);
  let ephemeralOn = $state(false);
  let query = $state("");
  let persist: ItemStore | null = null;
  let expiry: ExpiryScheduler | null = null;
  const watcher = new ClipboardWatcher({ intervalMs: 1000 });

  onMount(async () => {
    const key = await deriveRoomKey(room);
    persist = new PersistedItems({ roomId: room.routingId, key, cap: 50 });
    items = await persist.load();

    // Test-only hook: ?forceRelay=1 disables WebRTC so the relay path can be
    // exercised deterministically. A stub RTCPeerConnection whose data channel
    // never opens keeps transport = "relay" without throwing or affecting routing.
    const forceRelay = new URLSearchParams(location.search).has("forceRelay");

    const c = new UniclipClient({
      roomUrl,
      relayBase,
      deviceId: deviceId(),
      deviceName,
      ...(forceRelay
        ? {
            iceServers: [],
            createConnection: () =>
              ({
                onicecandidate: null,
                ondatachannel: null,
                onnegotiationneeded: null,
                onconnectionstatechange: null,
                signalingState: "stable",
                connectionState: "new",
                localDescription: null,
                createDataChannel: () => ({
                  readyState: "connecting",
                  send() {},
                  close() {},
                  onopen: null,
                  onclose: null,
                  onmessage: null,
                }),
                createOffer: async () => ({ type: "offer", sdp: "" }),
                createAnswer: async () => ({ type: "answer", sdp: "" }),
                setLocalDescription: async () => {},
                setRemoteDescription: async () => {},
                addIceCandidate: async () => {},
                close() {},
              }) as unknown as RTCPeerConnection,
          }
        : {}),
    });
    client = c;
    c.on("status", (s) => (status = s));
    c.on("peer", (n) => (peerCount = n));
    c.on("presence", (r) => (roster = r));
    c.on("transport", (v) => (transport = v));
    c.on("diag", (e) => {
      diagRows = pushDiag(diagRows, { phase: e.phase, level: e.level, detail: e.detail, t: Date.now() - diagStart });
    });
    c.on("room", (info) => {
      backfillOn = info.backfill;
      if (info.ephemeral && !ephemeralOn) {
        // Switch to no-persist + TTL. A room created ephemeral has no prior
        // persisted history, so resetting items is just belt-and-suspenders.
        ephemeralOn = true;
        persist = new EphemeralStore();
        expiry = new ExpiryScheduler(EPHEMERAL_TTL_MS, (msgId) => {
          items = items.filter((i) => i.id !== msgId);
        });
        items = [];
      }
    });
    c.on("clip", async (text, ts, msgId) => {
      await addItem(text, ts, msgId, false);
    });
    c.on("sent", (msgId) => {
      items = items.map((i) => (i.id === msgId ? { ...i, pending: false } : i));
      if (ephemeralOn) expiry?.schedule(msgId);
    });
    c.on("delete", async (msgId) => {
      items = items.filter((i) => i.id !== msgId);
      expiry?.cancel(msgId);
      await persist?.remove(msgId);
    });
    c.on("error", (e) => {
      if (e.code === "DECRYPT_FAILED") keyError = true;
      else toast(`${e.code}: ${e.message}`, "warn");
    });
    c.on("file-offer", (o) => { transfers = applyOffer(transfers, o, Date.now()); });
    c.on("file-progress", (p) => { transfers = applyProgress(transfers, p); });
    c.on("file-received", (r) => { transfers = applyReceived(transfers, r); });
    c.on("file-error", (e) => {
      transfers = applyError(transfers, e);
      toast(`Transfer failed: ${e.code}`, "warn");
    });
    c.on("file-cancel", (cc) => { transfers = applyCancel(transfers, cc); });
    await c.connect();

    watcher.on(async (text) => {
      try {
        const { msgId, ts, queued } = await c.send(text);
        await addItem(text, ts, msgId, true, queued);
      } catch {}
    });
  });

  onDestroy(() => {
    watcher.stop();
    expiry?.clear();
    client?.disconnect();
  });

  $effect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (ev.key === "?" && tag !== "INPUT" && tag !== "TEXTAREA") showDebug = !showDebug;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function addItem(text: string, ts: number, msgId: string, mine: boolean, queued = false) {
    if (items.some((i) => i.id === msgId)) return;
    const item: Item = { id: msgId, text, ts, mine, pending: queued };
    items = [...items, item].slice(-50);
    // `pending` is transient UI state — never persist it, or a reload would show
    // an already-delivered item stuck as "Queued" (the backfill clip replay is
    // dropped by the id dedup guard above, so it could never clear).
    await persist?.add({ id: msgId, text, ts, mine });
    // Ephemeral TTL starts at DELIVERY. A queued item is not delivered yet, so
    // its timer is scheduled later in the `sent` handler, not here.
    if (ephemeralOn && !queued) expiry?.schedule(msgId);
  }

  async function sendText(text: string) {
    try {
      if (!client) return;
      const { msgId, ts, queued } = await client.send(text);
      await addItem(text, ts, msgId, true, queued);
    } catch {
      toast("Send failed", "warn");
    }
  }

  async function sendFile(file: File) {
    if (!client) return;
    if (peerCount <= 1) {
      toast("No other device connected — open this room on another device first.", "warn");
      return;
    }
    if (tooLarge(file)) {
      toast(`Too large to send (max ${MAX_FILE_MB} MB).`, "warn");
      return;
    }
    try {
      const bytes = await readFileBytes(file);
      const res = await client.sendFile({
        name: file.name,
        mime: file.type || "application/octet-stream",
        bytes,
      });
      if (!res) return; // engine early-rejected; file-error already toasted
      transfers = addOutgoing(
        transfers,
        { fileId: res.fileId, name: file.name, mime: file.type || "application/octet-stream", size: file.size, total: res.chunkCount },
        Date.now(),
      );
    } catch {
      toast("Couldn't send that file", "warn");
    }
  }

  function onPaste(e: ClipboardEvent) {
    const clipItems = e.clipboardData?.items;
    if (!clipItems) return;
    for (const it of clipItems) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const file = it.getAsFile();
        if (file) {
          e.preventDefault(); // stage the image in the composer; Send/Enter sends it
          pendingFile = file;
          return;
        }
      }
    }
    // no image → let normal text paste proceed
  }

  function onDragEnter(e: DragEvent) {
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
      dragDepth += 1;
    }
  }
  function onDragOver(e: DragEvent) {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  }
  function onDragLeave() {
    if (dragDepth > 0) dragDepth -= 1;
  }
  function onDrop(e: DragEvent) {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    dragDepth = 0;
    for (const file of Array.from(e.dataTransfer.files)) void sendFile(file);
  }

  function acceptTransfer(fileId: string) {
    client?.acceptFile(fileId);
    transfers = markTransferring(transfers, fileId);
  }
  function declineTransfer(fileId: string) {
    client?.declineFile(fileId);
    transfers = removeTransfer(transfers, fileId);
  }
  function cancelTransfer(fileId: string) {
    const t = transfers.find((x) => x.fileId === fileId);
    if (t?.dir === "recv") {
      // The engine's cancelFile only handles sends. For an incoming transfer,
      // declineFile drops the engine's incoming entry + notifies the peer;
      // mark it cancelled locally (no file-cancel comes back to us).
      client?.declineFile(fileId);
      transfers = applyCancel(transfers, { fileId });
    } else {
      client?.cancelFile(fileId); // sender: engine emits file-cancel → applyCancel
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
    expiry?.cancel(id);
    await persist?.remove(id);
    client?.delete(id);
  }

  async function pinItem(id: string, pinned: boolean) {
    await persist?.setPinned(id, pinned);
    items = items.map((i) => (i.id === id ? { ...i, pinned } : i));
  }

  function visibleForExport() {
    return items.filter((i) => matchesQuery(i.text, query));
  }
  async function copyAll() {
    try { await navigator.clipboard.writeText(historyText(visibleForExport())); toast("History copied", "info", 1400); } catch {}
  }
  function downloadAll() {
    downloadTextFile("uniclip-history.txt", historyText(visibleForExport()));
  }

  function clearHistory() {
    items = [];
    expiry?.clear();
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

  function renameDevice(name: string) {
    deviceName = name;
    localStorage.setItem("uniclip.deviceName", name);
    client?.setDeviceName(name);
  }

  function endRoom() {
    persist?.clear();
    client?.disconnect();
  }
</script>

<svelte:window onpaste={onPaste} />

<!-- Drag-and-drop is a pointer enhancement; the attach button is the keyboard-accessible path. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="flex min-h-[100dvh] flex-col"
  ondragenter={onDragEnter}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
  <Header
    roomId={room.routingId}
    mode={room.mode}
    {peerCount}
    {status}
    {transport}
    ephemeral={ephemeralOn}
    syncing={watching}
    {roster}
    onToggleSync={toggleWatch}
    onShare={() => (showShare = true)}
    onClear={clearHistory}
    onEnd={endRoom}
    onRenameDevice={renameDevice}
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
        <Composer onSend={sendText} onSendFile={sendFile} {pendingFile} clearPending={() => (pendingFile = null)} onStageFile={(f) => (pendingFile = f)} />

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
      <div class="mb-2.5 flex items-center gap-2">
        <input
          bind:value={query}
          type="search"
          placeholder="Search items"
          aria-label="Search items"
          class="h-9 min-w-0 flex-1 rounded-field border border-border bg-surface px-3 text-sm text-text placeholder:text-faint focus:border-border-strong focus:outline-none"
        />
        <button type="button" onclick={copyAll} title="Copy all" aria-label="Copy all items" class="grid h-9 w-9 shrink-0 place-items-center rounded-field border border-border text-muted transition hover:bg-surface-2 hover:text-text">
          <svg viewBox="0 0 24 24" fill="none" class="h-[18px] w-[18px]" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M5 15V5a2 2 0 0 1 2-2h8" stroke="currentColor" stroke-width="1.6"/></svg>
        </button>
        <button type="button" onclick={downloadAll} title="Download .txt" aria-label="Download history as text" class="grid h-9 w-9 shrink-0 place-items-center rounded-field border border-border text-muted transition hover:bg-surface-2 hover:text-text">
          <svg viewBox="0 0 24 24" fill="none" class="h-[18px] w-[18px]" aria-hidden="true"><path d="M12 4v10m0 0l-4-4m4 4l4-4M5 18h14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <ItemsList {items} {transfers} {query} syncing={watching} onCopy={copy} {onDelete} onPin={pinItem} onAccept={acceptTransfer} onDecline={declineTransfer} onCancelTransfer={cancelTransfer} />
    </section>
  </main>

  <!-- Mobile bottom action bar (thumb zone) — composer only; sync moved to the header. -->
  <div
    class="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-bg/90 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-md lg:hidden"
  >
    <div class="mx-auto flex max-w-5xl flex-col gap-2">
      <Composer onSend={sendText} onSendFile={sendFile} {pendingFile} clearPending={() => (pendingFile = null)} onStageFile={(f) => (pendingFile = f)} />
    </div>
  </div>

  {#if showShare}
    <ShareModal url={shareUrl} mode={room.mode} onClose={() => (showShare = false)} />
  {/if}

  <Toaster />

  {#if dragging}
    <DropOverlay />
  {/if}

  {#if showDebug}
    <DebugOverlay rows={diagRows} {transport} onClose={() => (showDebug = false)} />
  {/if}
</div>

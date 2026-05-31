<script lang="ts">
  import { navigateToRoom } from "../lib/router";
  import { generateModeARoom } from "@uniclip/room-code";

  const relayBase = import.meta.env.VITE_RELAY_BASE ?? window.location.origin;

  let mode: "A" | "B" = $state("A");
  let joinCode = $state("");
  let creating = $state(false);

  async function startRoom() {
    creating = true;
    try {
      const res = await fetch(`${relayBase}/api/room`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const { roomId } = await res.json();
      const secret = mode === "A" ? generateModeARoom().secret : undefined;
      navigateToRoom(roomId, secret);
    } finally {
      creating = false;
    }
  }

  function join() {
    if (!joinCode) return;
    navigateToRoom(joinCode.trim().toUpperCase());
  }
</script>

<main class="mx-auto max-w-md p-8 space-y-6">
  <header>
    <h1 class="text-3xl font-semibold">Uniclip</h1>
    <p class="text-gray-500 text-sm">End-to-end encrypted clipboard sync.</p>
  </header>

  <section class="space-y-3">
    <h2 class="font-medium">Start a room</h2>
    <label class="flex items-center gap-2 text-sm">
      <input type="radio" bind:group={mode} value="A" />
      Zero-knowledge (share QR / link)
    </label>
    <label class="flex items-center gap-2 text-sm">
      <input type="radio" bind:group={mode} value="B" />
      Typed code (server can decrypt — less secure)
    </label>
    <button
      class="rounded bg-black text-white px-4 py-2 disabled:opacity-50"
      disabled={creating}
      onclick={startRoom}
    >
      {creating ? "Creating..." : "Start"}
    </button>
  </section>

  <section class="space-y-3">
    <h2 class="font-medium">Join with code</h2>
    <input
      class="w-full rounded border px-3 py-2 uppercase tracking-widest"
      maxlength="6"
      placeholder="QX7K2P"
      bind:value={joinCode}
    />
    <button class="rounded border px-4 py-2" onclick={join}>Join</button>
  </section>
</main>

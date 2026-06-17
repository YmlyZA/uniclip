<script lang="ts">
  import { navigateToRoom } from "../lib/router";
  import { generateModeARoom } from "@uniclip/room-code";
  import ThemeToggle from "../components/theme-toggle.svelte";
  import Toaster from "../components/toast.svelte";
  import { toast } from "../lib/toast";

  const relayBase = import.meta.env.VITE_RELAY_BASE ?? window.location.origin;

  let mode: "A" | "B" = $state("A");
  let backfill = $state(true);
  let ephemeral = $state(false);
  let joinCode = $state("");
  let creating = $state(false);

  async function startRoom() {
    creating = true;
    try {
      const res = await fetch(`${relayBase}/api/room`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode,
          backfill: mode === "A" && !ephemeral ? backfill : false,
          ephemeral,
        }),
      });
      if (!res.ok) {
        toast(res.status === 429 ? "Too many rooms — try again shortly" : "Couldn't create room", "warn");
        return;
      }
      const { roomId } = await res.json();
      const secret = mode === "A" ? generateModeARoom().secret : undefined;
      navigateToRoom(roomId, secret);
    } catch {
      toast("Network error — is the relay reachable?", "warn");
    } finally {
      creating = false;
    }
  }

  function join() {
    const raw = joinCode.trim();
    if (!raw) return;
    if (raw.includes("/r/") || raw.includes("#")) {
      // A pasted Mode-A link or path — preserve case, pull out routingId + #secret.
      const tail = raw.replace(/^.*\/r\//, "").replace(/^\/+/, "");
      const hash = tail.indexOf("#");
      const routingId = (hash >= 0 ? tail.slice(0, hash) : tail).trim();
      const secret = hash >= 0 ? tail.slice(hash + 1).trim() : "";
      if (routingId) navigateToRoom(routingId, secret || undefined);
    } else {
      // A bare typed code is a Mode-B room code (uppercase alphabet).
      navigateToRoom(raw.toUpperCase());
    }
  }
</script>

<div class="relative mx-auto flex min-h-[100dvh] w-full max-w-lg flex-col px-5 py-6 sm:py-10">
  <div class="flex items-center justify-between">
    <span class="flex items-center gap-2 font-display text-xl font-extrabold tracking-tight text-text">
      <span class="grid h-8 w-8 place-items-center rounded-field bg-accent text-accent-fg">
        <svg viewBox="0 0 24 24" fill="none" class="h-[18px] w-[18px]" aria-hidden="true">
          <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" stroke="currentColor" stroke-width="1.9" />
          <path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5" stroke="currentColor" stroke-width="1.9" />
        </svg>
      </span>
      uniclip
    </span>
    <ThemeToggle />
  </div>

  <div class="flex flex-1 flex-col justify-center py-8">
    <!-- Hero -->
    <div class="mb-7">
      <h1 class="font-display text-[2.6rem] font-extrabold leading-[1.05] tracking-tight text-text">
        Your clipboard,<br />
        <span class="text-accent text-glow">end-to-end encrypted.</span>
      </h1>
      <p class="mt-3 max-w-md text-[15px] leading-relaxed text-muted">
        Sync copied text across your devices through a relay that never sees your
        keys or plaintext.
      </p>
    </div>

    <!-- Start a room -->
    <div class="rounded-card border border-border bg-surface p-4 shadow-[var(--shadow-card)] sm:p-5">
      <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-faint">Start a room</h2>

      <div class="grid gap-2.5 sm:grid-cols-2">
        <!-- Mode A -->
        <button
          type="button"
          onclick={() => (mode = "A")}
          aria-pressed={mode === "A"}
          class="relative rounded-field border p-3.5 text-left transition
            {mode === 'A'
            ? 'border-accent bg-accent-soft glow-ring'
            : 'border-border bg-surface-2 hover:border-border-strong'}"
        >
          <span class="absolute right-3 top-3 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent">
            Recommended
          </span>
          <svg viewBox="0 0 24 24" fill="none" class="mb-2 h-5 w-5 text-accent" aria-hidden="true">
            <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" stroke-width="1.7" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="1.7" />
          </svg>
          <div class="text-sm font-semibold text-text">Zero-knowledge</div>
          <div class="mt-0.5 text-xs leading-snug text-muted">
            Secret stays in your link, never sent to the server. Share by QR / link.
          </div>
        </button>

        <!-- Mode B -->
        <button
          type="button"
          onclick={() => (mode = "B")}
          aria-pressed={mode === "B"}
          class="relative rounded-field border p-3.5 text-left transition
            {mode === 'B'
            ? 'border-warn bg-warn-soft'
            : 'border-border bg-surface-2 hover:border-border-strong'}"
        >
          <svg viewBox="0 0 24 24" fill="none" class="mb-2 h-5 w-5 {mode === 'B' ? 'text-warn' : 'text-muted'}" aria-hidden="true">
            <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" stroke-width="1.7" />
            <path d="M8 11V8a4 4 0 0 1 7-2.5" stroke="currentColor" stroke-width="1.7" />
          </svg>
          <div class="text-sm font-semibold text-text">Typed code</div>
          <div class="mt-0.5 text-xs leading-snug text-muted">
            Easy to read aloud, but the server can decrypt.
            <span class="font-medium text-warn">Less secure.</span>
          </div>
        </button>
      </div>

      {#if mode === "A"}
        <label class="mt-3 flex cursor-pointer items-start gap-2.5 rounded-field border border-border bg-surface-2 p-3 text-sm {ephemeral ? 'opacity-50' : ''}">
          <input
            type="checkbox"
            bind:checked={backfill}
            disabled={ephemeral}
            class="mt-0.5 h-4 w-4 accent-[var(--accent)]"
          />
          <span>
            <span class="font-medium text-text">Share recent items with late joiners</span>
            <span class="mt-0.5 block text-xs text-muted">Devices that join later receive the recent clips, while at least one device stays connected.</span>
          </span>
        </label>
      {/if}

      <label class="mt-2 flex cursor-pointer items-start gap-2.5 rounded-field border border-border bg-surface-2 p-3 text-sm">
        <input
          type="checkbox"
          bind:checked={ephemeral}
          class="mt-0.5 h-4 w-4 accent-[var(--accent)]"
        />
        <span>
          <span class="font-medium text-text">Ephemeral — don't save anything</span>
          <span class="mt-0.5 block text-xs text-muted">Nothing is written to disk on any device, and items vanish 60s after they arrive. Good for passwords and one-time codes.</span>
          {#if mode === "B"}
            <span class="mt-1 block text-xs font-medium text-warn">A Typed-code room is still readable by the server — pick Zero-knowledge for full privacy.</span>
          {/if}
        </span>
      </label>

      <button
        type="button"
        onclick={startRoom}
        disabled={creating}
        class="mt-3.5 flex w-full items-center justify-center gap-2 rounded-field bg-accent px-4 py-2.5 text-sm font-bold text-accent-fg transition hover:bg-accent-bright disabled:opacity-60"
      >
        {#if creating}
          <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4 animate-spin" aria-hidden="true">
            <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" opacity="0.25" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
          </svg>
          Creating…
        {:else}
          Create encrypted room
          <svg viewBox="0 0 24 24" fill="none" class="h-4 w-4" aria-hidden="true">
            <path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        {/if}
      </button>
    </div>

    <!-- Join -->
    <div class="mt-4 rounded-card border border-border bg-surface p-3 sm:p-3.5">
      <div class="flex items-center gap-2.5">
        <input
          class="min-w-0 flex-1 rounded-field border border-border bg-surface-2 px-3 py-2.5 font-mono text-sm text-text placeholder:text-faint focus:border-accent focus:outline-none"
          placeholder="Paste link or enter code"
          bind:value={joinCode}
          onkeydown={(e) => e.key === "Enter" && join()}
        />
        <button
          type="button"
          onclick={join}
          class="shrink-0 rounded-field border border-border-strong bg-surface-2 px-4 py-2.5 text-sm font-semibold text-text transition hover:border-accent hover:text-accent"
        >
          Join
        </button>
      </div>
      <p class="mt-2 px-0.5 text-xs text-faint">
        Zero-knowledge rooms: open or paste the full share link (it carries the secret).
        Typed codes are for less-secure rooms.
      </p>
    </div>
  </div>

  <p class="text-center text-xs text-faint">
    AES-256-GCM · PBKDF2 · text-only · open relay holds nothing
  </p>
</div>

<Toaster />

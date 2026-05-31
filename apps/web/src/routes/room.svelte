<script lang="ts">
  import type { ParsedRoom } from "@uniclip/room-code";
  let { room }: { room: ParsedRoom } = $props();
</script>

<main class="p-6">
  <h1 class="text-xl font-semibold">Room {room.routingId}</h1>
  <p class="text-sm text-gray-500">mode {room.mode}</p>
</main>

<script lang="ts">
  import { onMount } from "svelte";
  import { currentRoute, type Route } from "./lib/router";
  import Landing from "./routes/landing.svelte";
  import Room from "./routes/room.svelte";

  let route: Route = $state(currentRoute());

  onMount(() => {
    const onPop = () => (route = currentRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  });
</script>

{#if route.name === "landing"}
  <Landing />
{:else if route.name === "room"}
  <Room room={route.room} />
{/if}
